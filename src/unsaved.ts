const editors = new Set<symbol>();
export function registerUnsavedEditor() {
  const id = Symbol("editor");
  editors.add(id);
  return () => {
    editors.delete(id);
  };
}
export function confirmNavigation() {
  return (
    editors.size === 0 ||
    window.confirm("Discard your unsaved invitation edits and leave this page?")
  );
}
