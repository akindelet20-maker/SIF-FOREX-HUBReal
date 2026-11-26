(() => {
  const button = document.querySelector('.menu-toggle');
  const navigation = document.getElementById('navigation');
  if (!button || !navigation) return;

  const setOpen = (open) => {
    navigation.classList.toggle('active', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    button.textContent = open ? '×' : '☰';
  };

  button.addEventListener('click', () => {
    setOpen(button.getAttribute('aria-expanded') !== 'true');
  });
  navigation.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
})();
