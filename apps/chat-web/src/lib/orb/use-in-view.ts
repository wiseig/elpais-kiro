/** Deja de animar cuando el orbe no se ve o la pestaña está en segundo plano. */
export const observeActivity = (el: Element, onChange: (active: boolean) => void): (() => void) => {
  let inView = true;
  let pageVisible = document.visibilityState === 'visible';
  let active = inView && pageVisible;

  const sync = () => {
    const next = inView && pageVisible;
    if (next === active) return;
    active = next;
    onChange(next);
  };

  const observer = new IntersectionObserver((entries) => {
    inView = entries[entries.length - 1]?.isIntersecting ?? true;
    sync();
  });
  observer.observe(el);

  const onVisibility = () => {
    pageVisible = document.visibilityState === 'visible';
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  };
};
