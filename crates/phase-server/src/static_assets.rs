//! Same-origin hosting of the built web client.
//!
//! Off unless `--static-dir` / `PHASE_STATIC_DIR` names a directory. When it is
//! set, one phase-server process is the whole self-hosted deployment: the app
//! bundle, the card data the app fetches, `/health`, and `/ws` all answer on a
//! single origin and a single port. No nginx sidecar, no init container that
//! pre-stages a `dist` artifact, no second origin to keep in sync.
//!
//! Three things beyond "serve a directory" earn their place here:
//!
//! 1. **Cache headers mirror `client/deploy/cloudflare-pages/_headers`**, which
//!    is the authority on this bundle's caching. `/assets/` is content-addressed
//!    and cached forever; everything else must revalidate.
//! 2. **The server's own data files are exposed at the site root.** A client
//!    built without `DATA_BASE_URL` fetches `/card-data.json` from its own
//!    origin, and this server already keeps that file current in
//!    `PHASE_DATA_DIR` (see [`crate::data_bootstrap`]). Only the files the
//!    bootstrap manages are exposed — never the data directory itself, which
//!    also holds `games.db` and log files.
//! 3. **A WebSocket handshake on any path reaches the game socket.** Serving the
//!    app and the socket from one origin is only half the win: a client pointed
//!    at `wss://host` with no `/ws` path would otherwise be answered by the SPA
//!    fallback with `200 text/html`, which a browser reports as a generic
//!    connection failure rather than "you used the wrong path". Answering the
//!    handshake wherever it arrives makes that failure class impossible.

use std::path::Path;

use axum::extract::{Request, State};
use axum::response::IntoResponse;
use axum::routing::MethodRouter;
use axum::Router;
use http::header::{CACHE_CONTROL, UPGRADE, VARY};
use http::{HeaderMap, HeaderValue};
use tower::{Layer, ServiceExt};
use tower_http::compression::{CompressionLayer, CompressionLevel};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::data_bootstrap::MANAGED_DATA_FILES;

/// Vite emits `/assets/` filenames that change whenever their bytes change, so
/// a browser never needs to ask about one twice. Matches the `/assets/*` rule in
/// `client/deploy/cloudflare-pages/_headers`.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// Everything that is not content-addressed. `_headers` names the entry points
/// individually (`index.html`, `sw.js`, `registerSW.js`, `manifest.webmanifest`,
/// `workbox-*.js`); applying the same policy to every non-`/assets/` path is a
/// superset of that list, so a bundle that grows a new entry point cannot start
/// serving stale copies of it. `max-age=0, must-revalidate` still allows a cheap
/// conditional GET — the common answer is a 304, not a re-download.
const REVALIDATE: &str = "public, max-age=0, must-revalidate";

/// `ServeDir`/`ServeFile` pick a response body by `Accept-Encoding` but do not
/// say so, which lets a shared cache hand a Brotli body to a client that cannot
/// read one.
const ACCEPT_ENCODING: &str = "accept-encoding";

/// Mount the client bundle and the server's client-visible data files onto the
/// public router.
///
/// `websocket` is the same route as `/ws`; it is reached from the fallback so a
/// handshake on any other path is answered rather than mistaken for a page load.
///
/// Errors when `static_dir` has no `index.html`: a directory that cannot answer
/// the entry point serves nothing but 404s, and starting up anyway is the exact
/// class of confusing failure this module exists to remove.
pub(crate) fn mount<S>(
    router: Router<S>,
    static_dir: &Path,
    data_dir: &Path,
    websocket: MethodRouter<S>,
) -> Result<Router<S>, String>
where
    S: Clone + Send + Sync + 'static,
{
    let index = static_dir.join("index.html");
    if !index.is_file() {
        return Err(format!(
            "--static-dir {} has no index.html; point it at the built client (client/dist)",
            static_dir.display()
        ));
    }

    // Hashed bundle output. `precompressed_br` serves the `.br` sibling that
    // `vite-plugin-compression2` emits next to every JS/CSS/HTML asset, so the
    // wire cost matches what a compressing reverse proxy would have achieved
    // without paying to compress anything at request time.
    let assets = header(CACHE_CONTROL, IMMUTABLE).layer(
        header(VARY, ACCEPT_ENCODING)
            .layer(ServeDir::new(static_dir.join("assets")).precompressed_br()),
    );

    // Everything else in the bundle, with an SPA fallback: an unknown path is a
    // client route, not a missing file. A missing `/assets/` file still 404s —
    // that nest has no fallback of its own — so a stale asset reference fails
    // loudly instead of resolving to HTML.
    let bundle = header(CACHE_CONTROL, REVALIDATE).layer(
        header(VARY, ACCEPT_ENCODING).layer(
            ServeDir::new(static_dir)
                .precompressed_br()
                .fallback(ServeFile::new(&index).precompressed_br()),
        ),
    );

    let mut router = router.nest_service("/assets", assets);

    // The data files this server keeps current, at the paths a client built
    // without `DATA_BASE_URL` looks for them. Compressed on the fly: card-data
    // is tens of megabytes of JSON and has no precompressed sibling on disk,
    // and `Fastest` keeps a cold fetch from monopolising a small host's CPU.
    for file in MANAGED_DATA_FILES {
        router = router.route_service(
            &format!("/{file}"),
            header(CACHE_CONTROL, REVALIDATE).layer(
                CompressionLayer::new()
                    .quality(CompressionLevel::Fastest)
                    .layer(ServeFile::new(data_dir.join(file))),
            ),
        );
    }

    Ok(
        router.fallback(move |State(state): State<S>, request: Request| {
            let bundle = bundle.clone();
            let websocket = websocket.clone();
            async move {
                if is_websocket_upgrade(request.headers()) {
                    return websocket
                        .with_state(state)
                        .oneshot(request)
                        .await
                        .into_response();
                }
                match bundle.oneshot(request).await {
                    Ok(response) => response.into_response(),
                    // `ServeDir`'s error type is `Infallible` once it has a
                    // fallback; this arm is uninhabited.
                    Err(never) => match never {},
                }
            }
        }),
    )
}

/// Overriding rather than appending: `ServeDir` already sets no `Cache-Control`,
/// and an appended second value would leave the policy ambiguous.
fn header(name: http::HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value))
}

/// Whether this request opens a WebSocket. RFC 6455 §4.1 sends
/// `Upgrade: websocket`; RFC 9110 §7.8 makes `Upgrade` a comma-separated list
/// whose tokens are case-insensitive, so match a member rather than the whole
/// value.
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
        })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use axum::extract::WebSocketUpgrade;
    use axum::routing::get;
    use axum::Router;
    use http::HeaderMap;

    use super::{is_websocket_upgrade, mount, IMMUTABLE, REVALIDATE};

    const INDEX_HTML: &str = "<!doctype html><title>phase</title><div id=root></div>";
    const ASSET_JS: &str = "console.log('bundle');";
    const CARD_DATA: &str =
        r#"{"cards":[],"note":"padded so the compression layer has something to work with"}"#;

    /// A temp directory laid out like `client/dist`, plus the data directory the
    /// bootstrap would have populated.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().expect("temp dir");
        let static_dir = temp.path().join("dist");
        let data_dir = temp.path().join("data");
        std::fs::create_dir_all(static_dir.join("assets")).expect("assets dir");
        std::fs::create_dir_all(&data_dir).expect("data dir");
        std::fs::write(static_dir.join("index.html"), INDEX_HTML).expect("index");
        std::fs::write(static_dir.join("assets/app-deadbeef.js"), ASSET_JS).expect("asset");
        std::fs::write(data_dir.join("card-data.json"), CARD_DATA).expect("card data");
        (temp, static_dir, data_dir)
    }

    /// Mirrors production wiring: existing routes first, then the bundle, with
    /// the same route object reachable from `/ws` and from the fallback.
    async fn spawn(static_dir: &Path, data_dir: &Path) -> (String, tokio::task::JoinHandle<()>) {
        async fn accept(ws: WebSocketUpgrade) -> axum::response::Response {
            ws.on_upgrade(|_socket| async {})
        }
        let app = Router::new()
            .route("/health", get(|| async { "ok" }))
            .route("/ws", get(accept));
        let app = mount(app, static_dir, data_dir, get(accept))
            .expect("fixture dist has an index.html")
            .with_state(());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        (format!("http://{addr}"), handle)
    }

    fn upgrade_headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(http::header::UPGRADE, value.parse().expect("header value"));
        headers
    }

    #[test]
    fn websocket_upgrade_is_recognized_case_and_list_insensitively() {
        assert!(is_websocket_upgrade(&upgrade_headers("websocket")));
        assert!(is_websocket_upgrade(&upgrade_headers("WebSocket")));
        assert!(is_websocket_upgrade(&upgrade_headers("h2c, websocket")));
        assert!(!is_websocket_upgrade(&upgrade_headers("h2c")));
        assert!(!is_websocket_upgrade(&HeaderMap::new()));
    }

    #[tokio::test]
    async fn hashed_assets_are_immutable_and_missing_ones_still_404() {
        let (_temp, static_dir, data_dir) = fixture();
        let (base, server) = spawn(&static_dir, &data_dir).await;
        let client = reqwest::Client::new();

        let response = client
            .get(format!("{base}/assets/app-deadbeef.js"))
            .send()
            .await
            .expect("asset request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            response.headers()[http::header::CACHE_CONTROL],
            IMMUTABLE,
            "content-addressed assets must never be revalidated"
        );
        assert_eq!(response.headers()[http::header::VARY], "accept-encoding");
        assert_eq!(response.text().await.expect("asset body"), ASSET_JS);

        // A stale reference must fail loudly rather than resolve to the SPA
        // shell, which would surface as a syntax error inside the bundle.
        let missing = client
            .get(format!("{base}/assets/app-cafebabe.js"))
            .send()
            .await
            .expect("missing asset request");
        assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);

        server.abort();
    }

    #[tokio::test]
    async fn client_routes_fall_back_to_index_and_must_revalidate() {
        let (_temp, static_dir, data_dir) = fixture();
        let (base, server) = spawn(&static_dir, &data_dir).await;
        let client = reqwest::Client::new();

        for path in ["/", "/index.html", "/deck-builder/new"] {
            let response = client
                .get(format!("{base}{path}"))
                .send()
                .await
                .expect("spa request");
            assert_eq!(response.status(), reqwest::StatusCode::OK, "{path}");
            assert_eq!(
                response.headers()[http::header::CACHE_CONTROL],
                REVALIDATE,
                "{path} decides which bundle the user lands on"
            );
            assert_eq!(
                response.text().await.expect("spa body"),
                INDEX_HTML,
                "{path}"
            );
        }

        server.abort();
    }

    #[tokio::test]
    async fn existing_routes_keep_precedence_over_the_bundle() {
        let (_temp, static_dir, data_dir) = fixture();
        let (base, server) = spawn(&static_dir, &data_dir).await;

        let response = reqwest::get(format!("{base}/health"))
            .await
            .expect("health request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.expect("health body"), "ok");

        server.abort();
    }

    #[tokio::test]
    async fn managed_data_files_are_served_from_the_data_directory() {
        let (_temp, static_dir, data_dir) = fixture();
        let (base, server) = spawn(&static_dir, &data_dir).await;

        let response = reqwest::get(format!("{base}/card-data.json"))
            .await
            .expect("card data request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.expect("card data body"), CARD_DATA);

        // Only the bootstrap's own files; the data directory also holds
        // games.db, which must stay unreachable.
        let leaked = reqwest::get(format!("{base}/games.db"))
            .await
            .expect("games.db request");
        assert_eq!(leaked.status(), reqwest::StatusCode::OK);
        assert_eq!(
            leaked.text().await.expect("games.db body"),
            INDEX_HTML,
            "an unmapped path is a client route, never a data-directory file"
        );

        server.abort();
    }

    #[tokio::test]
    async fn a_handshake_on_any_path_reaches_the_websocket() {
        let (_temp, static_dir, data_dir) = fixture();
        let (base, server) = spawn(&static_dir, &data_dir).await;
        let ws_base = base.replace("http://", "ws://");

        // `/` and `/ws` are the two a self-hoster is most likely to hand a
        // client; without the fallback interception the first would answer the
        // handshake with the SPA shell and a misleading connection failure.
        for path in ["", "/ws", "/anything"] {
            tokio_tungstenite::connect_async(format!("{ws_base}{path}"))
                .await
                .unwrap_or_else(|error| panic!("handshake on {path:?} failed: {error}"));
        }

        server.abort();
    }
}
