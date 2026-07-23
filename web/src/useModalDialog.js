import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0 && !element.closest("[inert]")
  );
}

export default function useModalDialog(open, onClose, panelRef) {
  const lastFocused = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    lastFocused.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const background = [
      document.querySelector(".app-header"),
      document.querySelector(".app"),
      document.querySelector(".app-footer"),
    ].filter(Boolean);
    const previousInert = background.map((element) => ({
      element,
      hadAttribute: element.hasAttribute("inert"),
      value: element.getAttribute("inert"),
    }));
    for (const element of background) element.setAttribute("inert", "");

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (
        document.activeElement === panel ||
        document.activeElement === first ||
        !panel.contains(document.activeElement)
      )) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (
        document.activeElement === panel ||
        document.activeElement === last ||
        !panel.contains(document.activeElement)
      )) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const { element, hadAttribute, value } of previousInert) {
        if (hadAttribute) element.setAttribute("inert", value ?? "");
        else element.removeAttribute("inert");
      }
      lastFocused.current?.focus?.();
    };
  }, [open, panelRef]);
}
