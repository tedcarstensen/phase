//! "Request takeback" — multiplayer-safe undo (GH #1507).
//!
//! Single-player/local undo (`engine-wasm::restore_game_state`) replaces the
//! client's own state wholesale and is refused outright in multiplayer
//! sessions, because no client may unilaterally rewrite the authoritative
//! server state another player is relying on. This module gives multiplayer
//! sessions an equivalent escape hatch for misclicks and UI confusion,
//! without ever letting one player rewrite history unilaterally: a player
//! may request to roll the *authoritative* session state back to the
//! snapshot taken just before their most recent action, but the rollback
//! only takes effect once every human seat at the table (the requester
//! included) has approved it. Any single human decline cancels the request
//! and the authoritative state is left untouched.
//!
//! The same machine is parameterized by [`RewindTarget`] rather than
//! duplicated per granularity. `LastAction` is the original GH #1507 undo;
//! `Action` names any retained rollback point by its stable
//! [`TakebackEntry::sequence`], so a player can reach a *specific* earlier
//! action of their own rather than only their most recent one; `TurnStart`
//! reaches a previous turn boundary. All three resolve through one authority
//! ([`GameSession::resolve_rewind_target`]) onto the same approval state
//! machine.
//!
//! Reaching an arbitrary earlier action is a *retention* problem, not a
//! constant-inflation one: every wire `PassPriority` and every mana-source tap
//! would otherwise burn one of the twelve action slots, so a flat ring reaches
//! back roughly one priority round. [`RewindSignificance`] splits that traffic
//! into a recycled noise tier and a reserved decisive tier
//! ([`retain_takeback_entry`]), which is what makes twelve slots hold twelve
//! *meaningful* rollback points instead of twelve priority passes.
//!
//! Turn boundaries are a genuinely different capture — a transition's own
//! post-state, kept in a second ring and offered only where
//! [`offers_turn_rewind`] says so.
//!
//! **Whose actions.** A player may only anchor a rollback on one of their
//! *own* actions, at every granularity. That is not a new restriction: it is
//! what `LastAction` has always meant, lifted into
//! [`GameSession::resolve_action_rewind`] so the `Action` selector cannot
//! quietly widen it into "propose undoing someone else's play."
//!
//! This is intentionally a session/room-level concern, not an engine rule —
//! there is no Comprehensive Rules concept of "undo." The engine is never
//! told why it was handed an older `GameState`; it just continues from
//! whatever state it's given, exactly as it does on reconnect/restore.

use std::collections::{HashSet, VecDeque};

use engine::types::actions::GameAction;
use engine::types::events::GameEvent;
use engine::types::game_state::GameState;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use phase_ai::session::AiSession;
use serde::{Deserialize, Serialize};

use crate::session::{GameSession, HostingMode};

/// How many prior authoritative snapshots a session retains for takeback
/// purposes. Bounded so a long game session can't accumulate unbounded
/// memory — a takeback can only reach back to the most recent action, so
/// anything beyond a handful of entries is never reachable anyway.
pub const MAX_TAKEBACK_HISTORY: usize = 12;

/// How many turn-boundary snapshots a session retains. Deliberately the same
/// depth as the browser-local analogue (`client/src/constants/game.ts`'s
/// `MAX_UNDO_HISTORY = 5`), so desktop solo-vs-AI offers the same reach the
/// browser sandbox already does. Small because these are whole `GameState`
/// clones and — unlike `MAX_TAKEBACK_HISTORY` — only ever populated on a
/// `HostingMode::SingleUser` sidecar (see [`offers_turn_rewind`]).
pub const MAX_TURN_REWIND_HISTORY: usize = 5;

/// How many of [`MAX_TAKEBACK_HISTORY`]'s slots may be held by
/// [`RewindSignificance::Routine`] entries at once.
///
/// The reserve is the whole point of the split. Without it, a burst of
/// priority passes and mana taps evicts every decisive rollback point in the
/// ring and "undo the spell I misclicked" becomes unreachable after one
/// priority round — which is exactly the reach failure raising
/// `MAX_TAKEBACK_HISTORY` would paper over rather than fix. Small because a
/// routine snapshot is only ever wanted while it is still recent: the payment
/// steps it belongs to are undone wholesale by rewinding to before the cast
/// they were paying for.
pub const MAX_ROUTINE_TAKEBACK_ENTRIES: usize = 4;

/// How much of the game the action following a snapshot committed, and
/// therefore how aggressively that snapshot may be recycled.
///
/// A typed retention class rather than a `bool`, so the policy in
/// [`retain_takeback_entry`] reads as the two-tier rule it is and so the
/// published [`UndoableAction`] can label a row without the client inferring
/// anything from the action name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewindSignificance {
    /// Flow control, and the incremental steps of a cost that has not been
    /// committed yet: priority passes, mana-source activations (CR 605.3a),
    /// pool pins (CR 118.3a), and auto-pass toggles. These are the structural
    /// noise floor — a single two-player turn produces more of them than the
    /// entire ring holds.
    Routine,
    /// Everything else: putting a spell on the stack, playing a land,
    /// declaring attackers or blockers, answering an engine prompt. These are
    /// the actions a player actually asks to take back, so they hold their
    /// slots against routine traffic.
    Decisive,
}

impl RewindSignificance {
    /// Classifies one action for retention.
    ///
    /// Defined by enumerating the *closed* noise set rather than by an
    /// exhaustive match over all ~130 `GameAction` variants, and the wildcard
    /// direction is load-bearing: an action this classifier has never heard of
    /// is `Decisive`, i.e. it keeps its slot. A new engine action can therefore
    /// only ever be over-retained, never silently recycled out from under a
    /// player who wanted it back.
    pub fn of(action: &GameAction) -> Self {
        match action {
            // CR 117.3d: passing priority commits nothing; it is the single
            // highest-volume action on the wire.
            GameAction::PassPriority
            // CR 605.3a + CR 118.3a: mana-source activation, pool pinning and
            // their inverses are steps *inside* an uncommitted payment.
            | GameAction::TapLandForMana { .. }
            | GameAction::ActivateManaSource { .. }
            | GameAction::UntapLandForMana { .. }
            | GameAction::BackToManaPayment
            | GameAction::SpendPoolMana { .. }
            | GameAction::UnspendPoolMana { .. }
            | GameAction::PayManaAbilityMana { .. }
            | GameAction::ChooseManaColor { .. }
            // CR 702.51a (convoke) + CR 702.180a (harmonize): alternative ways
            // to pay the same uncommitted cost.
            | GameAction::TapForConvoke { .. }
            | GameAction::HarmonizeTap { .. }
            // Auto-pass is a client-side pacing preference. `CancelAutoPass`
            // never reaches here (`is_actor_scoped_preference` records no
            // snapshot for it); it is listed so the pair cannot drift apart.
            | GameAction::SetAutoPass { .. }
            | GameAction::CancelAutoPass => Self::Routine,
            _ => Self::Decisive,
        }
    }
}

/// One recorded rollback point: the authoritative state immediately before one
/// player's action, together with everything the server needs to publish and
/// re-select it.
///
/// Replaces the previous `(PlayerId, GameState)` tuple because a granular
/// selector needs three things a tuple has nowhere to put: a stable handle, a
/// retention class, and a label.
#[derive(Debug, Clone)]
pub struct TakebackEntry {
    /// Stable for the life of the session and never reused — not reset at a
    /// match's game boundary, unlike the rings themselves.
    ///
    /// A client selects a rollback point by this id rather than by index
    /// *because* retention evicts from the middle of the ring: an index
    /// captured one action ago can name a different entry by the time the
    /// request arrives, whereas a stale sequence resolves to nothing and is
    /// refused. Starts at 1, so `0` is never a live handle.
    pub sequence: u64,
    /// The player whose action this snapshot precedes. Also the only player
    /// permitted to anchor a rollback on it — see
    /// [`GameSession::resolve_action_rewind`].
    pub actor: PlayerId,
    /// `GameAction::variant_name()` of that action. A coarse action *type*, not
    /// its payload: the fact that a player cast a spell at a given point is
    /// public (CR 601.2), the identity of what they cast is not necessarily,
    /// and only the former is retained here.
    pub action: &'static str,
    pub significance: RewindSignificance,
    /// The authoritative state as it stood immediately before `action`.
    pub state: GameState,
}

/// One action a player may ask the table to roll back to, as published by the
/// server.
///
/// Every field is read from the stored [`TakebackEntry`] and its own snapshot,
/// never recomputed at publication time, so the row a player clicks describes
/// exactly the state they would get. Published per viewer and already narrowed
/// to that viewer's own actions, so the client renders the list it is handed
/// and derives nothing.
///
/// Deliberately *not* a sibling of [`RewindOption`]: that publishes a turn
/// boundary captured from a transition's post-state and offered only on a
/// sidecar; this publishes an action's pre-state and is offered in every mode.
/// They share no field and no gating.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoableAction {
    /// Echo back as `RewindTarget::Action { sequence }` to select this row.
    pub sequence: u64,
    pub actor: PlayerId,
    pub action: String,
    pub turn_number: u32,
    pub phase: Phase,
    pub significance: RewindSignificance,
}

/// What an approver is being asked to give up, published with the request.
///
/// Unanimity is the whole safety argument for rolling back past another
/// player's action — a rollback that discards an opponent's response cannot
/// un-reveal that they held it, so the only thing that can legitimize the leak
/// is the affected player's own consent. Consent to "some rollback" is not
/// consent to "a rollback nine actions deep", so the depth travels with the
/// prompt rather than being left for the approver to guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TakebackScope {
    /// Turn and phase of the state that would be restored, read from the target
    /// snapshot itself.
    pub turn_number: u32,
    pub phase: Phase,
    /// `variant_name()` of the requester's action being taken back, or `None`
    /// for a `TurnStart` rewind, which is anchored on a turn boundary rather
    /// than on any one action.
    pub action: Option<String>,
    /// How many retained rollback points are discarded, the anchor included.
    ///
    /// A **lower bound** on actions discarded, not an exact count: routine
    /// steps are recycled out of the ring by [`retain_takeback_entry`] long
    /// before they leave the game's history. `turn_number`/`phase` are the
    /// exact statement of how far back this reaches; this is the coarse
    /// "how much am I giving up" number beside it.
    pub discarded_points: usize,
}

/// How far back a rollback request reaches.
///
/// Parameterizes the one rollback machine rather than growing a sibling wire
/// message per granularity: the approval state machine, the pending-request
/// interlock, `rekey_after_trusted_restore`, and the reconnect replay are all
/// shared. `LastAction` is the pre-existing GH #1507 behaviour and is the
/// `Default` so an absent wire payload from a pre-rewind client normalizes to
/// exactly what that client meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RewindTarget {
    /// Roll back to the snapshot taken immediately before the requester's own
    /// most recent state-mutating action.
    #[default]
    LastAction,
    /// Roll back to the snapshot taken immediately before one *specific*
    /// retained action of the requester's, named by its
    /// [`TakebackEntry::sequence`].
    ///
    /// The general form of `LastAction`, which stays as a distinct selector
    /// for two reasons that are not granularity: it is relative (it needs no
    /// published list to name, and cannot go stale between publication and
    /// request), and it is the `Default` a pre-rewind client's payload-free
    /// frame normalizes to. Both resolve through
    /// [`GameSession::resolve_action_rewind`], so there is one authority for
    /// what an action rollback means.
    Action { sequence: u64 },
    /// Roll back to the start of the numbered turn *of the current game*.
    /// Turn numbers are only unique within a game (see
    /// [`GameSession::observe_transition`]), which is why the rings are
    /// cleared at a match's game boundary rather than keyed by game number.
    TurnStart { turn_number: u32 },
}

/// One turn boundary a client may ask to roll back to, as published by the
/// server. Both fields are read from the stored snapshot's *own* state, never
/// recomputed at publication time, so the label a player clicks is exactly the
/// state they get.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RewindOption {
    pub turn_number: u32,
    pub active_player: PlayerId,
}

/// Rollback availability for one authoritative transition, captured once under
/// the same lock as the transition itself.
///
/// One captured value rather than two independent reads. The turn list and the
/// per-seat action list describe the same instant and travel in the same
/// message, and reading them separately is exactly how a `StateUpdate` ends up
/// carrying a turn list from before `run_ai` and an action list from after it —
/// the failure the existing capture-site comments in `phase-server` already
/// warn about for the turn list alone.
#[derive(Debug, Clone, Default)]
pub struct RewindPublication {
    /// Turn boundaries. Identical for every seat, and empty off a
    /// `HostingMode::SingleUser` sidecar (see [`offers_turn_rewind`]).
    pub turn_boundaries: Vec<RewindOption>,
    /// Rollback points per seat, indexed by `PlayerId.0`, each already narrowed
    /// to that seat's own actions. Narrowed here rather than at the client
    /// because choosing which rows a viewer may act on is a rule, not
    /// formatting.
    per_seat: Vec<Vec<UndoableAction>>,
}

impl RewindPublication {
    /// The rollback points `viewer` may select.
    ///
    /// A viewer outside the seat range — the spectator pseudo-seat — gets none.
    /// That is the true answer rather than a special case: a spectator anchors
    /// no rollback, so there is nothing to offer them.
    pub fn for_seat(&self, viewer: PlayerId) -> Vec<UndoableAction> {
        self.per_seat
            .get(viewer.0 as usize)
            .cloned()
            .unwrap_or_default()
    }
}

/// Whether this deployment offers turn-granular rewind.
///
/// A **policy**, not a capability of the mechanism: the machinery below is
/// mode-agnostic and `LastAction` is deliberately *not* scoped by it. Nobody
/// asked for a table-wide vote at turn scale, and the trigger surface
/// (`DebugPanel`) is not gated by `showSandboxTools` — it is reachable in every
/// mode via the keyboard shortcut. Gating capture as well as publication means
/// a shared server retains zero turn snapshots rather than retaining snapshots
/// it will never offer.
pub fn offers_turn_rewind(hosting: HostingMode) -> bool {
    hosting == HostingMode::SingleUser
}

/// Records `entry` in the action ring under the two-tier retention policy.
///
/// A free function over the ring for the same reason as
/// [`record_turn_rewind_point`]: the policy's interesting cases are pure
/// sequence properties (a routine burst must not evict decisive reach; a full
/// ring must spend noise before reach) and need no session at all. Callers go
/// through [`GameSession::push_takeback_state`], which owns sequence assignment.
///
/// Two bounds, applied in this order:
///
/// 1. **Routine quota.** A routine push first recycles routine slots, so pass
///    and mana-tap traffic can never grow past [`MAX_ROUTINE_TAKEBACK_ENTRIES`]
///    no matter how long the priority round runs.
/// 2. **Ring bound.** Whoever is pushing, an over-full ring gives up its oldest
///    *routine* entry before it gives up any decisive one, and only falls back
///    to `pop_front` when there is no noise left to spend.
///
/// Eviction from the middle keeps the ring chronological, which is the property
/// the rest of the module reads it with: retained entries stay in action order,
/// so a prefix of the ring is still exactly the ancestors of any entry in it
/// (`history_truncate_len`) and `state.turn_number` stays monotone
/// (`partition_point`). Only *density* changes — an evicted point stops being
/// offered, it never becomes mis-ordered.
pub fn retain_takeback_entry(ring: &mut VecDeque<TakebackEntry>, entry: TakebackEntry) {
    if entry.significance == RewindSignificance::Routine {
        // The `&&` is a termination guard, not an optimization: the loop
        // condition is a count, and only the eviction's own report proves the
        // count can still go down.
        while routine_count(ring) >= MAX_ROUTINE_TAKEBACK_ENTRIES && evict_oldest_routine(ring) {}
    }
    while ring.len() >= MAX_TAKEBACK_HISTORY {
        if !evict_oldest_routine(ring) {
            ring.pop_front();
        }
    }
    ring.push_back(entry);
}

fn routine_count(ring: &VecDeque<TakebackEntry>) -> usize {
    ring.iter()
        .filter(|entry| entry.significance == RewindSignificance::Routine)
        .count()
}

/// Drops the oldest routine entry, reporting whether there was one. `false` is
/// what tells [`retain_takeback_entry`] the ring is all reach and the bound has
/// to come out of it.
fn evict_oldest_routine(ring: &mut VecDeque<TakebackEntry>) -> bool {
    let Some(index) = ring
        .iter()
        .position(|entry| entry.significance == RewindSignificance::Routine)
    else {
        return false;
    };
    ring.remove(index).is_some()
}

/// Records `state` as a turn-boundary rewind point iff the transition that
/// produced it *came to rest in* the turn its own events announced.
///
/// A free function over the ring rather than a `&mut self` method, so the
/// capture rule can be exercised directly against a `VecDeque` and a synthetic
/// event batch — the rule's hostile cases (a batch that both starts and ends a
/// turn, a batch carrying two boundaries) need no session at all. Callers go
/// through [`GameSession::observe_transition`], which is the `&mut self` wrapper
/// that also owns the game-boundary retirement; nothing calls this directly in
/// production.
///
/// The `started != state.turn_number` guard is an honesty guard, not an
/// optimization: a batch that both started *and* ended a turn leaves no state
/// that could be truthfully labelled with either turn, so that boundary is not
/// offered rather than mislabelled.
///
/// **Uniqueness.** No two retained entries share a `turn_number`, *within a
/// game*: `state.turn_number` is assigned 1 at a game start
/// (`engine::game::engine`'s two `start_game_*` helpers) and thereafter only
/// incremented, unconditionally and once per turn start
/// (`engine/src/game/turns.rs`, CR 500.7 — including extra turns; a *skipped*
/// turn increments without emitting `TurnStarted`). `TurnStarted` has three
/// production emission sites — `turns.rs` plus those two `start_game_*`
/// helpers, which both emit `TurnStarted { turn_number: 1 }` — so uniqueness is
/// a within-game property only. Crossing into another game of a Bo3 match is
/// handled by [`GameSession::observe_transition`], which clears both rings, and
/// the `debug_assert!` below is what fails loudly if that ever stops happening.
pub fn record_turn_rewind_point(
    ring: &mut VecDeque<GameState>,
    hosting: HostingMode,
    events: &[GameEvent],
    state: &GameState,
) {
    if !offers_turn_rewind(hosting) {
        return;
    }
    let Some(started) = events.iter().rev().find_map(|event| match event {
        GameEvent::TurnStarted { turn_number, .. } => Some(*turn_number),
        _ => None,
    }) else {
        return;
    };
    if started != state.turn_number {
        return;
    }
    debug_assert!(
        ring.back()
            .is_none_or(|s| s.turn_number < state.turn_number),
        "turn rewind ring must stay strictly increasing within a game"
    );
    if ring.len() >= MAX_TURN_REWIND_HISTORY {
        ring.pop_front();
    }
    ring.push_back(state.clone());
}

/// A takeback request awaiting unanimous human approval.
#[derive(Debug, Clone)]
pub struct PendingTakeback {
    /// The player who asked for the takeback. Implicitly counted as having
    /// approved their own request.
    pub requested_by: PlayerId,
    /// The authoritative state to restore if every human seat approves —
    /// the snapshot taken immediately before the requester's last
    /// state-mutating action.
    pub target_state: GameState,
    /// Human seats that have approved so far. The request resolves the
    /// instant this set contains every human seat in the session.
    pub approvals: HashSet<PlayerId>,
    /// How much of `takeback_history` remains a genuine ancestor chain of
    /// `target_state` once the rollback lands. Computed at request time,
    /// which is sound because every path that could mutate the history
    /// refuses while a request is pending (`handle_action`,
    /// `handle_interaction`, `handle_match_concede`) and `run_ai` is a no-op.
    pub history_truncate_len: usize,
    /// What every approver is being asked to give up. Computed once at request
    /// time from the resolved target — the same reasoning as
    /// `history_truncate_len` — so the prompt a late-reconnecting approver
    /// replays describes the same rollback the first broadcast did.
    pub scope: TakebackScope,
}

/// One [`RewindTarget`] resolved against the session's retained history.
///
/// The three fields a request needs and nothing else: the state to install,
/// the ancestor prefix of the action ring that survives installing it, and the
/// action being taken back (`None` for a turn boundary, which is anchored on no
/// single action). Kept as a named struct rather than a tuple because
/// `history_truncate_len` and a turn number are both plain integers and the
/// pair has been transposed before.
struct ResolvedRewind {
    target_state: GameState,
    history_truncate_len: usize,
    action: Option<&'static str>,
}

/// Outcome of requesting or responding to a takeback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TakebackOutcome {
    /// Still waiting on one or more human players to respond.
    Pending,
    /// Every human seat approved — the session state has already been
    /// rolled back to the target snapshot by the time this is returned.
    Approved,
    /// A human player declined — the request was withdrawn and the
    /// authoritative state is unchanged.
    Rejected,
}

impl GameSession {
    /// Records the current authoritative state as a takeback checkpoint,
    /// tagged with the player about to take `action`.
    ///
    /// Tagging by actor (rather than just "most recent action") is what lets
    /// `request_takeback` find *this player's* last action even when other
    /// players have acted since — see its doc comment.
    pub fn push_takeback_snapshot(&mut self, actor: PlayerId, action: &GameAction) {
        self.push_takeback_state(actor, self.state.clone(), action);
    }

    /// Records the pre-action state for an action that has already succeeded.
    /// Keeping the state explicit lets the session apply through the engine
    /// first, so rejected attempts never become undo points.
    ///
    /// The single assignment point for [`TakebackEntry::sequence`]. Retention
    /// itself lives in [`retain_takeback_entry`]; this is the `&mut self`
    /// wrapper that owns the counter, which is deliberately *not* reset with
    /// the rings at a match's game boundary — a handle a client captured in
    /// the previous game must miss, never collide.
    pub fn push_takeback_state(&mut self, actor: PlayerId, state: GameState, action: &GameAction) {
        self.rewind_sequence = self.rewind_sequence.saturating_add(1);
        retain_takeback_entry(
            &mut self.takeback_history,
            TakebackEntry {
                sequence: self.rewind_sequence,
                actor,
                action: action.variant_name(),
                significance: RewindSignificance::of(action),
                state,
            },
        );
    }

    /// The rollback points `player` may currently ask the table to return to,
    /// oldest first.
    ///
    /// Narrowed to `player`'s own actions at the source rather than published
    /// whole and filtered by the client: the same rule
    /// [`GameSession::resolve_action_rewind`] enforces on the request, so a row
    /// this returns is a row that request cannot refuse for ownership.
    pub fn undoable_actions(&self, player: PlayerId) -> Vec<UndoableAction> {
        self.takeback_history
            .iter()
            .filter(|entry| entry.actor == player)
            .map(|entry| UndoableAction {
                sequence: entry.sequence,
                actor: entry.actor,
                action: entry.action.to_string(),
                turn_number: entry.state.turn_number,
                phase: entry.state.phase,
                significance: entry.significance,
            })
            .collect()
    }

    /// The single per-transition rewind bookkeeping authority. Every
    /// authoritative state transition calls this with **its own** event batch
    /// and post-state — never with `self.state`, which several call sites have
    /// already advanced past the transition being recorded.
    ///
    /// Two responsibilities, in this order because the second depends on the
    /// first: retire both rings at a match's game boundary, then record the
    /// turn boundary this transition came to rest in (if any).
    ///
    /// **Why the game-boundary clear.** `turn_number` is *assigned* 1 at each
    /// game's start rather than carried across a Bo3 match (CR 100.6a: a
    /// two-player match is a series of *games*), and the
    /// between-games `ChoosePlayDraw` action rebuilds the state through
    /// `handle_action` — a capture site — with `TurnStarted { turn_number: 1 }`
    /// in its batch. Without this, `turn_number` is not monotone across the
    /// session, and a `TurnStart { n }` request would resolve by first match to
    /// a *finished game's* turn n and install that board into the live game.
    /// Both rings are retired, not just the turn ring: a rollback into a
    /// previous game of the match is not a coherent offer at any granularity,
    /// and clearing both is what restores the within-game monotonicity that
    /// `partition_point`, `retain`, and `record_turn_rewind_point`'s
    /// `debug_assert!` all rely on. (`takeback_history` was not previously
    /// cleared on a game transition — it is cleared only after an approved
    /// rollback — so this is a new, deliberate retirement point for it.)
    pub fn observe_transition(&mut self, events: &[GameEvent], state: &GameState) {
        if state.game_number != self.rewind_game_number {
            self.rewind_game_number = state.game_number;
            self.takeback_history.clear();
            self.turn_rewind_history.clear();
        }
        record_turn_rewind_point(&mut self.turn_rewind_history, self.hosting, events, state);
    }

    /// The turn boundaries this session currently offers, oldest first. Each
    /// option is labelled from its snapshot's *own* fields, so the label and
    /// the state a player gets cannot disagree.
    pub fn rewind_options(&self) -> Vec<RewindOption> {
        if !offers_turn_rewind(self.hosting) {
            return Vec::new();
        }
        self.turn_rewind_history
            .iter()
            .map(|state| RewindOption {
                turn_number: state.turn_number,
                active_player: state.active_player,
            })
            .collect()
    }

    /// Everything this session currently offers as a rollback destination,
    /// captured as one value so the two lists cannot be read at different
    /// instants. This is what every transport fan-out captures under the
    /// session lock and threads through its per-seat builders.
    pub fn rewind_publication(&self) -> RewindPublication {
        RewindPublication {
            turn_boundaries: self.rewind_options(),
            per_seat: (0..self.player_count)
                .map(|seat| self.undoable_actions(PlayerId(seat)))
                .collect(),
        }
    }

    /// Human (non-AI) seats in this session, in seat order. AI seats never
    /// request, approve, or block a takeback — they have no UI to misclick.
    pub fn human_seats(&self) -> Vec<PlayerId> {
        (0..self.player_count)
            .map(PlayerId)
            .filter(|p| !self.ai_seats.contains(p))
            .collect()
    }

    /// Resolves the pending request if every human seat has now approved,
    /// applying the rollback in place. Returns `None` if still pending.
    fn try_resolve_pending_takeback(&mut self) -> Option<TakebackOutcome> {
        let pending = self.pending_takeback.as_ref()?;
        let humans = self.human_seats();
        if !humans.iter().all(|p| pending.approvals.contains(p)) {
            return None;
        }
        let pending = self.pending_takeback.take().expect("checked above");
        self.state = pending.target_state;
        engine::game::rekey_after_trusted_restore(&mut self.state);
        // The rolled-back state is the new baseline. Snapshots *after* the
        // restored one belong to the branch the table just discarded, and
        // taking another takeback back through them would resurrect actions
        // the table just agreed to undo. Snapshots *before* it are still
        // genuine ancestors of it, and a takeback that targets one of those
        // goes strictly further back — discarding strictly more, resurrecting
        // nothing. `history_truncate_len`, computed at request time, is
        // exactly that ancestor prefix; `clear()` was the conservative
        // over-approximation of this same reasoning, and truncating is what
        // makes undo repeatable rather than one-shot.
        self.takeback_history.truncate(pending.history_truncate_len);
        // `<=`, not `<`: a `TurnStart { n }` rewind targets the turn-n
        // snapshot itself, so keeping turn n selectable is what makes turn
        // rewind idempotent and repeatable rather than consuming its own
        // target.
        let restored_turn = self.state.turn_number;
        self.turn_rewind_history
            .retain(|snapshot| snapshot.turn_number <= restored_turn);
        // Every other path that installs a `GameState` wholesale rebuilds the
        // AI session (`GameSession::start_game`, `from_persisted`); this one
        // must too, now that an approved rollback can be followed immediately
        // by `run_ai`. Rebuild rather than invalidate selectively:
        // `rekey_after_trusted_restore` rewrites object identity, so the
        // cached routes and prompts keyed on the discarded branch's ids are
        // stale by construction, not merely cold.
        if self.ai_session.is_some() {
            self.ai_session = Some(AiSession::arc_from_game(&self.state));
        }
        Some(TakebackOutcome::Approved)
    }

    /// A human player requests rolling the game back to the state just
    /// before *their own* most recent action — not simply the most recent
    /// action by anyone. Other players may have acted since; rolling back
    /// to before the requester's action necessarily discards those later
    /// actions too (there is no way to keep them while undoing an earlier
    /// action they were built on), but it must never target a snapshot that
    /// precedes a different player's action while leaving the requester's
    /// own action untouched. Auto-resolves to `Approved` immediately when
    /// the requester is the only human at the table (e.g. solo vs. AI)
    /// since there is nobody else to ask.
    ///
    /// `target` selects the granularity. `RewindTarget::Action` reaches a
    /// specific earlier action of the requester's; `RewindTarget::TurnStart`
    /// reaches a boundary the action ring cannot hold at all, since a whole
    /// turn (CR 500.1) outlives even the reserved decisive tier.
    pub fn request_takeback(
        &mut self,
        player: PlayerId,
        target: RewindTarget,
    ) -> Result<TakebackOutcome, String> {
        self.reject_if_ai_driver_faulted()?;
        if self.pending_takeback.is_some() {
            return Err("A takeback request is already pending for this game".to_string());
        }
        if !self.human_seats().contains(&player) {
            return Err("Only human players may request a takeback".to_string());
        }
        let resolved = self.resolve_rewind_target(player, target)?;

        let mut approvals = HashSet::new();
        approvals.insert(player);
        self.pending_takeback = Some(PendingTakeback {
            requested_by: player,
            scope: TakebackScope {
                turn_number: resolved.target_state.turn_number,
                phase: resolved.target_state.phase,
                action: resolved.action.map(str::to_string),
                discarded_points: self.takeback_history.len() - resolved.history_truncate_len,
            },
            target_state: resolved.target_state,
            approvals,
            history_truncate_len: resolved.history_truncate_len,
        });

        Ok(self
            .try_resolve_pending_takeback()
            .unwrap_or(TakebackOutcome::Pending))
    }

    /// The single authority for what a [`RewindTarget`] means. Every selector
    /// lands here, so the ownership rule, the truncation predicate, and the
    /// refusal wording cannot drift apart across granularities.
    fn resolve_rewind_target(
        &self,
        player: PlayerId,
        target: RewindTarget,
    ) -> Result<ResolvedRewind, String> {
        match target {
            RewindTarget::LastAction => {
                let sequence = self
                    .takeback_history
                    .iter()
                    .rev()
                    .find(|entry| entry.actor == player)
                    .map(|entry| entry.sequence)
                    .ok_or_else(|| {
                        "There is no previous action of yours to take back".to_string()
                    })?;
                self.resolve_action_rewind(player, sequence)
            }
            RewindTarget::Action { sequence } => self.resolve_action_rewind(player, sequence),
            RewindTarget::TurnStart { turn_number } => {
                // Refuse explicitly rather than letting an always-empty ring
                // produce a "no longer available" miss. This is a system
                // boundary, and a refusal that depends on a collection being
                // empty is untestably vacuous.
                if !offers_turn_rewind(self.hosting) {
                    return Err("Turn rewind is not available in this game".to_string());
                }
                let target_state = self
                    .turn_rewind_history
                    .iter()
                    .find(|snapshot| snapshot.turn_number == turn_number)
                    .ok_or_else(|| "That turn is no longer available to rewind to".to_string())?
                    .clone();
                // An exact prefix predicate: within a game the action ring is
                // chronological and `turn_number` is monotone, so every entry
                // recorded before turn `n` began is an ancestor of turn `n`'s
                // opening state, and every entry from turn `n` onwards is not.
                let history_truncate_len = self
                    .takeback_history
                    .partition_point(|entry| entry.state.turn_number < turn_number);
                Ok(ResolvedRewind {
                    target_state,
                    history_truncate_len,
                    // A turn boundary is anchored on a transition, not on any
                    // one player's action, so there is no action to name.
                    action: None,
                })
            }
        }
    }

    /// Resolves one retained action rollback point by its stable sequence.
    ///
    /// Shared by `LastAction` and `Action` so the **ownership rule** has one
    /// site: a player may only anchor a rollback on their *own* action. That is
    /// what `LastAction` has always meant; stating it here is what stops the
    /// `Action` selector from generalizing into "propose undoing someone
    /// else's play", which is a different social contract than the one the
    /// table agreed to when it approved a takeback.
    ///
    /// The index of the entry *is* `history_truncate_len`: entries before it
    /// are genuine ancestors of the restored state and survive the rollback;
    /// the entry itself and everything after it belong to the branch being
    /// discarded.
    fn resolve_action_rewind(
        &self,
        player: PlayerId,
        sequence: u64,
    ) -> Result<ResolvedRewind, String> {
        let index = self
            .takeback_history
            .iter()
            .position(|entry| entry.sequence == sequence)
            .ok_or_else(|| "That action is no longer available to take back".to_string())?;
        let entry = &self.takeback_history[index];
        if entry.actor != player {
            return Err("You may only take back your own actions".to_string());
        }
        Ok(ResolvedRewind {
            target_state: entry.state.clone(),
            history_truncate_len: index,
            action: Some(entry.action),
        })
    }

    /// A human player approves or declines the pending takeback request.
    /// A single decline withdraws the request outright (unanimity required).
    pub fn respond_takeback(
        &mut self,
        player: PlayerId,
        approve: bool,
    ) -> Result<TakebackOutcome, String> {
        self.reject_if_ai_driver_faulted()?;
        if self.pending_takeback.is_none() {
            return Err("There is no pending takeback request".to_string());
        }
        if !self.human_seats().contains(&player) {
            return Err("Only human players may respond to a takeback request".to_string());
        }

        if !approve {
            self.pending_takeback = None;
            return Ok(TakebackOutcome::Rejected);
        }

        if let Some(pending) = self.pending_takeback.as_mut() {
            pending.approvals.insert(player);
        }
        Ok(self
            .try_resolve_pending_takeback()
            .unwrap_or(TakebackOutcome::Pending))
    }

    /// The original requester withdraws their own pending takeback request.
    pub fn cancel_takeback(&mut self, player: PlayerId) -> Result<(), String> {
        self.reject_if_ai_driver_faulted()?;
        match &self.pending_takeback {
            Some(pending) if pending.requested_by == player => {
                self.pending_takeback = None;
                Ok(())
            }
            Some(_) => Err("Only the player who requested the takeback may cancel it".to_string()),
            None => Err("There is no pending takeback request".to_string()),
        }
    }

    /// The `TakebackRequested` notification for the current pending request,
    /// if any. Used both for the original broadcast when a request goes out
    /// and to replay the same prompt to a socket that (re)connects while the
    /// vote is still in flight — otherwise a disconnected approver comes
    /// back with no way to respond, and `handle_action` rejects all actions
    /// while a request is pending, stalling the table.
    pub fn pending_takeback_message(&self) -> Option<crate::protocol::ServerMessage> {
        let pending = self.pending_takeback.as_ref()?;
        let requester_name = self
            .display_names
            .get(pending.requested_by.0 as usize)
            .cloned()
            .unwrap_or_default();
        Some(crate::protocol::ServerMessage::TakebackRequested {
            requester: pending.requested_by,
            requester_name,
            scope: Some(pending.scope.clone()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state that has come to rest in `turn_number`, with `active_player`
    /// distinct from seat 0 so a label mix-up is visible.
    fn resting_at(turn_number: u32) -> GameState {
        let mut state = GameState::new_two_player(42);
        state.turn_number = turn_number;
        state.active_player = PlayerId(1);
        state
    }

    fn turn_started(turn_number: u32) -> GameEvent {
        GameEvent::TurnStarted {
            player_id: PlayerId(1),
            turn_number,
        }
    }

    /// R1. The capture rule is driven by the transition's own post-state: a
    /// batch that announces turn 4 and comes to rest in turn 4 is recorded, and
    /// the entry is labelled from the stored state's own fields.
    #[test]
    fn record_turn_rewind_point_stores_the_boundary_it_came_to_rest_in() {
        let mut ring = VecDeque::new();
        record_turn_rewind_point(
            &mut ring,
            HostingMode::SingleUser,
            &[turn_started(4)],
            &resting_at(4),
        );
        assert_eq!(ring.len(), 1);
        assert_eq!(ring[0].turn_number, 4);
        assert_eq!(ring[0].active_player, PlayerId(1));
    }

    /// R1 hostile A. A batch that both *started* and *ended* a turn leaves no
    /// state that could be labelled truthfully, so the boundary is refused
    /// rather than mislabelled. Without the `started != state.turn_number`
    /// guard this stores a snapshot of turn 5 under the label "turn 4".
    #[test]
    fn a_batch_that_started_and_ended_a_turn_records_nothing() {
        let mut ring = VecDeque::new();
        record_turn_rewind_point(
            &mut ring,
            HostingMode::SingleUser,
            &[turn_started(4)],
            &resting_at(5),
        );
        assert!(ring.is_empty());
    }

    /// R1 hostile B. Two boundaries in one batch must produce exactly one
    /// entry, taken from the LAST announcement — the one the state rests in.
    #[test]
    fn a_batch_carrying_two_boundaries_records_only_the_one_it_rests_in() {
        let mut ring = VecDeque::new();
        record_turn_rewind_point(
            &mut ring,
            HostingMode::SingleUser,
            &[turn_started(4), turn_started(5)],
            &resting_at(5),
        );
        assert_eq!(
            ring.len(),
            1,
            "no duplicate entry for the passed-through turn"
        );
        assert_eq!(ring[0].turn_number, 5);
    }

    /// R1 hostile C. A batch with no boundary at all leaves the ring alone.
    #[test]
    fn a_batch_with_no_turn_boundary_records_nothing() {
        let mut ring = VecDeque::new();
        record_turn_rewind_point(
            &mut ring,
            HostingMode::SingleUser,
            &[GameEvent::PriorityPassed {
                player_id: PlayerId(0),
            }],
            &resting_at(4),
        );
        assert!(ring.is_empty());
    }

    /// R2. Capture — not just publication — is scoped to the sidecar, so a
    /// shared server retains zero turn snapshots. R1's positive case is the
    /// reach guard: the identical fixture DOES store under `SingleUser`, so
    /// this assertion is not vacuous.
    #[test]
    fn turn_rewind_capture_is_silent_on_a_shared_host() {
        let mut ring = VecDeque::new();
        record_turn_rewind_point(
            &mut ring,
            HostingMode::Shared,
            &[turn_started(4)],
            &resting_at(4),
        );
        assert!(ring.is_empty());
        assert!(!offers_turn_rewind(HostingMode::Shared));
        assert!(offers_turn_rewind(HostingMode::SingleUser));
    }

    /// Pushes one entry through the real retention policy, classifying it from
    /// a real `GameAction` so these tests exercise the classifier and the ring
    /// together rather than a hand-asserted significance.
    fn push(ring: &mut VecDeque<TakebackEntry>, sequence: u64, action: &GameAction) {
        retain_takeback_entry(
            ring,
            TakebackEntry {
                sequence,
                actor: PlayerId(0),
                action: action.variant_name(),
                significance: RewindSignificance::of(action),
                state: GameState::new_two_player(42),
            },
        );
    }

    fn sequences(ring: &VecDeque<TakebackEntry>) -> Vec<u64> {
        ring.iter().map(|entry| entry.sequence).collect()
    }

    fn count(ring: &VecDeque<TakebackEntry>, significance: RewindSignificance) -> usize {
        ring.iter()
            .filter(|entry| entry.significance == significance)
            .count()
    }

    /// A unit-variant decisive action, so these tests need no payload fixtures.
    const DECISIVE: GameAction = GameAction::CancelCast;
    const ROUTINE: GameAction = GameAction::PassPriority;

    /// R4. The classifier's two tiers. `PassPriority` and the uncommitted
    /// payment steps are noise; everything else — including an action the
    /// classifier has never been told about — keeps its slot.
    #[test]
    fn significance_recycles_flow_control_and_retains_everything_else() {
        assert_eq!(
            RewindSignificance::of(&GameAction::PassPriority),
            RewindSignificance::Routine
        );
        assert_eq!(
            RewindSignificance::of(&GameAction::BackToManaPayment),
            RewindSignificance::Routine
        );
        assert_eq!(
            RewindSignificance::of(&GameAction::CancelAutoPass),
            RewindSignificance::Routine
        );
        assert_eq!(
            RewindSignificance::of(&GameAction::CancelCast),
            RewindSignificance::Decisive
        );
        assert_eq!(
            RewindSignificance::of(&GameAction::CompanionToHand),
            RewindSignificance::Decisive
        );
    }

    /// R5. **The reason the tier split exists.** An unbounded burst of priority
    /// passes must not cost a single decisive rollback point. Without the
    /// reserve this leaves twelve `PassPriority` entries and the eight casts
    /// are unreachable — which is the reach failure the feature is about.
    #[test]
    fn routine_traffic_cannot_evict_decisive_reach() {
        let mut ring = VecDeque::new();
        for sequence in 1..=8 {
            push(&mut ring, sequence, &DECISIVE);
        }
        for sequence in 100..120 {
            push(&mut ring, sequence, &ROUTINE);
        }
        assert_eq!(count(&ring, RewindSignificance::Decisive), 8);
        assert_eq!(
            count(&ring, RewindSignificance::Routine),
            MAX_ROUTINE_TAKEBACK_ENTRIES
        );
        assert_eq!(ring.len(), 8 + MAX_ROUTINE_TAKEBACK_ENTRIES);
        assert_eq!(
            sequences(&ring)[..8],
            [1, 2, 3, 4, 5, 6, 7, 8],
            "every decisive rollback point must survive the burst intact"
        );
    }

    /// R6. Routine entries recycle their own quota, keeping the newest — a
    /// mis-tap is only ever wanted back while it is still recent.
    #[test]
    fn routine_entries_recycle_their_quota_newest_first() {
        let mut ring = VecDeque::new();
        for sequence in 1..=6 {
            push(&mut ring, sequence, &ROUTINE);
        }
        assert_eq!(ring.len(), MAX_ROUTINE_TAKEBACK_ENTRIES);
        assert_eq!(sequences(&ring), vec![3, 4, 5, 6]);
    }

    /// R7. A ring with no noise left to spend still honours the hard bound, and
    /// spends it from the FRONT. Asserting both ends fails a `pop_back`
    /// inversion.
    #[test]
    fn a_ring_of_pure_reach_drops_its_oldest() {
        let mut ring = VecDeque::new();
        let overflow = MAX_TAKEBACK_HISTORY as u64 + 1;
        for sequence in 1..=overflow {
            push(&mut ring, sequence, &DECISIVE);
        }
        assert_eq!(ring.len(), MAX_TAKEBACK_HISTORY);
        assert_eq!(ring.front().expect("bounded ring").sequence, 2);
        assert_eq!(ring.back().expect("bounded ring").sequence, overflow);
    }

    /// R8. When the bound has to give, noise pays before reach — even though
    /// the noise here is NEWER than the decisive entries it protects. A
    /// plain `pop_front` would drop decisive entry 5 instead.
    #[test]
    fn a_full_ring_spends_noise_before_reach() {
        let mut ring = VecDeque::new();
        for sequence in 1..=4 {
            push(&mut ring, sequence, &ROUTINE);
        }
        for sequence in 5..=12 {
            push(&mut ring, sequence, &DECISIVE);
        }
        assert_eq!(ring.len(), MAX_TAKEBACK_HISTORY);

        push(&mut ring, 13, &DECISIVE);
        assert_eq!(ring.len(), MAX_TAKEBACK_HISTORY);
        assert_eq!(
            sequences(&ring),
            vec![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            "the OLDEST routine entry paid for the new decisive one"
        );
    }

    /// R9. Eviction from the middle must leave the ring chronological — the
    /// property `history_truncate_len` (prefix = ancestors) and
    /// `partition_point` (monotone turn numbers) both read it with.
    #[test]
    fn retention_leaves_the_ring_in_action_order() {
        let mut ring = VecDeque::new();
        for sequence in 1..=40 {
            let action = if sequence % 3 == 0 { ROUTINE } else { DECISIVE };
            push(&mut ring, sequence, &action);
        }
        assert_eq!(ring.len(), MAX_TAKEBACK_HISTORY);
        assert!(
            sequences(&ring).windows(2).all(|pair| pair[0] < pair[1]),
            "retained entries must stay strictly ordered: {:?}",
            sequences(&ring)
        );
    }

    /// R3. The ring is bounded and drops the OLDEST entry. Asserting both ends
    /// is what fails a `pop_back` inversion.
    #[test]
    fn turn_rewind_ring_is_bounded_and_drops_oldest() {
        let mut ring = VecDeque::new();
        let overflow = MAX_TURN_REWIND_HISTORY as u32 + 2;
        for turn in 1..=overflow {
            record_turn_rewind_point(
                &mut ring,
                HostingMode::SingleUser,
                &[turn_started(turn)],
                &resting_at(turn),
            );
        }
        assert_eq!(ring.len(), MAX_TURN_REWIND_HISTORY);
        assert_eq!(
            ring.front().expect("bounded ring is non-empty").turn_number,
            3,
            "the two oldest turns must have been dropped from the FRONT"
        );
        assert_eq!(
            ring.back().expect("bounded ring is non-empty").turn_number,
            overflow,
            "the newest turn must be at the BACK"
        );
    }
}
