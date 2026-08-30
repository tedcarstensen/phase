import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";

import type { RewindOption, RewindTarget, UndoableAction } from "../../adapter/types";

interface TakebackTargetPickerProps {
  isOpen: boolean;
  /**
   * This seat's own rollback points, oldest first, exactly as the server
   * published them. Already narrowed to this viewer server-side — the picker
   * renders the rows it is handed and filters nothing.
   */
  undoableActions: UndoableAction[];
  /** Turn boundaries the server offers, oldest first. Empty off a sidecar. */
  turnBoundaries: RewindOption[];
  onSelect: (target: RewindTarget) => void;
  onCancel: () => void;
}

/**
 * Splits an engine `GameAction` variant name into words for display —
 * `"CastSpell"` → `"Cast Spell"`.
 *
 * Presentation only. The label is the engine's own action *type*, published
 * verbatim; nothing here decides which rows exist, which are selectable, or
 * what selecting one does.
 */
function humanizeActionName(action: string): string {
  return action.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * Picks which rollback the table will be asked to approve.
 *
 * Opened from the game menu in place of the immediate last-action request, but
 * only when the server has published more than one destination — with a single
 * choice there is nothing to pick, and the menu sends the last-action request
 * directly as it always has.
 *
 * Every row is a server-published destination echoed back verbatim as a
 * `RewindTarget`; the picker never constructs a handle of its own, so a row
 * that has been recycled out of the server's ring simply stops being offered
 * rather than becoming a stale request.
 */
export function TakebackTargetPicker({
  isOpen,
  undoableActions,
  turnBoundaries,
  onSelect,
  onCancel,
}: TakebackTargetPickerProps) {
  const { t } = useTranslation("multiplayer");
  // Newest first: the row a player wants is almost always the most recent one.
  const actions = [...undoableActions].reverse();
  const turns = [...turnBoundaries].reverse();

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            className="absolute inset-0 bg-black/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
          />
          <motion.div
            className="relative z-10 flex max-h-[80vh] w-96 flex-col rounded-xl bg-gray-900 p-6 shadow-2xl ring-1 ring-gray-700"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
          >
            <h2 className="mb-1 text-xl font-bold text-white">
              {t("takebackPicker.title")}
            </h2>
            <p className="mb-4 text-sm text-gray-400">{t("takebackPicker.subtitle")}</p>

            <div className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1">
              {actions.map((action) => (
                <button
                  key={`action-${action.sequence}`}
                  onClick={() => onSelect({ kind: "action", sequence: action.sequence })}
                  className="flex w-full items-center justify-between rounded-lg bg-gray-800 px-4 py-2 text-left text-sm text-gray-200 transition hover:bg-gray-700"
                >
                  <span>
                    {t("takebackPicker.actionRow", {
                      turn: action.turn_number,
                      action: humanizeActionName(action.action),
                    })}
                  </span>
                  {action.significance === "routine" && (
                    <span className="ml-3 shrink-0 text-xs text-gray-500">
                      {t("takebackPicker.routine")}
                    </span>
                  )}
                </button>
              ))}
              {turns.map((turn) => (
                <button
                  key={`turn-${turn.turn_number}`}
                  onClick={() =>
                    onSelect({ kind: "turn_start", turn_number: turn.turn_number })}
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-left text-sm text-gray-200 transition hover:bg-gray-700"
                >
                  {t("takebackPicker.turnRow", { turn: turn.turn_number })}
                </button>
              ))}
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={onCancel}
                className="rounded-lg bg-gray-700 px-5 py-2 text-sm font-semibold text-gray-200 transition hover:bg-gray-600"
              >
                {t("takebackPicker.cancel")}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
