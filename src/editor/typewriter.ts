import { EditorView } from "@codemirror/view";

// Typewriter mode (F9): keep the caret line in the middle of the window while typing or moving
// with the keyboard. Mouse selections are left alone so clicking doesn't jolt the page.
export const typewriter = [
  EditorView.updateListener.of((u) => {
    if (!u.view.hasFocus) return;
    const keyboard = u.transactions.some(
      (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete") || (tr.isUserEvent("select") && !tr.isUserEvent("select.pointer")),
    );
    if (!keyboard) return;
    // Scrolling needs its own transaction, which can't be dispatched during this update.
    requestAnimationFrame(() => {
      u.view.dispatch({ effects: EditorView.scrollIntoView(u.view.state.selection.main.head, { y: "center" }) });
    });
  }),
  EditorView.editorAttributes.of({ class: "ov-typewriter" }),
];
