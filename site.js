(() => {
  const button = document.querySelector('.menu-toggle');
  const navigation = document.getElementById('navigation');

  // The homepage already owns its navigation toggle inline; the shared handler is for inner pages.
  if (button && navigation && !document.body.classList.contains('page-home')) {
    const setNavigationOpen = (open) => {
      navigation.classList.toggle('active', open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      button.textContent = open ? '×' : '☰';
    };

    button.addEventListener('click', () => {
      setNavigationOpen(button.getAttribute('aria-expanded') !== 'true');
    });
    navigation.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => setNavigationOpen(false));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setNavigationOpen(false);
    });
  }

  if (document.querySelector('.sif-contact-widget')) return;

  const introMessage = 'Hello SIF FOREX HUB, I visited your website and would like to make an enquiry. Please assist me.';
  const links = {
    whatsapp: `https://wa.me/2349063261262?text=${encodeURIComponent(introMessage)}`,
    tiktok: 'https://tiktok.com/@sifforexhub_001',
    instagram: 'https://www.instagram.com/sifforexhub001',
    telegram: 'https://t.me/SifForexHub001'
  };
  const icons = {
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.4a8.4 8.4 0 0 1-8.7 8.1 9 9 0 0 1-4-.9L3.5 20l1.2-4.1a7.7 7.7 0 0 1-1.3-4.2A8.3 8.3 0 0 1 12 3.5a8.3 8.3 0 0 1 8.5 7.9Z"/><path d="M8 9.2h8M8 12.3h5.6"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 11.6a8.5 8.5 0 0 1-12.5 7.5L3.2 20l.8-4.3a8.5 8.5 0 1 1 16.4-4.1Z"/><path d="M8.3 7.8c.2-.4.5-.6.9-.6h.5c.2 0 .4.2.5.4l.8 1.7c.1.2 0 .4-.1.6l-.6.7c-.2.2-.2.4-.1.6.6 1 1.2 1.6 2.2 2.1.2.1.4.1.6-.1l.7-.8c.2-.2.4-.2.6-.1l1.6.8c.2.1.3.3.3.5v.5c0 .4-.2.7-.5.9-.6.4-1.4.5-2.3.2-1-.3-2.2-.9-3.4-2.1-1.2-1.2-1.8-2.4-2-3.3-.2-.8-.1-1.5.3-2Z"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 3.5v10.8a3.3 3.3 0 1 1-2.6-3.2"/><path d="M13.2 3.5c.5 3.1 2.4 5 5.4 5.6"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5"/><circle cx="12" cy="12" r="4.1"/><circle cx="17.7" cy="6.4" r=".8" fill="currentColor" stroke="none"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 4-6.8 16-3.4-6.8L4 10l17-6Z"/><path d="m10.8 13.2 5.1-4.7"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>'
  };
  const menuItems = [
    { label: 'WhatsApp', detail: 'Chat with me directly', icon: 'whatsapp', href: links.whatsapp, aria: 'Chat with SIF FOREX HUB on WhatsApp' },
    { label: 'TikTok', detail: 'Visit my official TikTok profile', icon: 'tiktok', href: links.tiktok, aria: 'Visit the official SIF FOREX HUB TikTok profile' },
    { label: 'Instagram', detail: 'Visit my official Instagram profile', icon: 'instagram', href: links.instagram, aria: 'Visit the official SIF FOREX HUB Instagram profile' }
  ];
  const menuOptions = menuItems.map((item) => `
    <a class="sif-contact-option" href="${item.href}" target="_blank" rel="noopener noreferrer" aria-label="${item.aria}">
      <span class="sif-contact-option__icon sif-contact-option__icon--${item.icon}">${icons[item.icon]}</span>
      <span class="sif-contact-option__copy"><strong>${item.label}</strong><small>${item.detail}</small></span>
      <span class="sif-contact-option__arrow">${icons.arrow}</span>
    </a>`).join('');

  const widget = document.createElement('div');
  widget.className = 'sif-contact-widget';
  widget.innerHTML = `
    <div class="sif-contact-menu" id="sif-contact-menu" role="dialog" aria-label="Contact SIF FOREX HUB" hidden>
      <div class="sif-contact-menu__header">
        <div><span class="sif-contact-menu__eyebrow">OFFICIAL CHANNELS</span><h2>How can we help?</h2><p>Choose a channel to connect with us.</p></div>
        <button class="sif-contact-close" type="button" aria-label="Close contact options">${icons.close}</button>
      </div>
      <div class="sif-contact-options">${menuOptions}</div>
      <p class="sif-contact-menu__note">We’re happy to help with your questions and enquiries.</p>
    </div>
    <button class="sif-contact-launcher" type="button" aria-label="Open contact options" aria-controls="sif-contact-menu" aria-expanded="false" title="Contact SIF FOREX HUB">${icons.chat}<span class="sif-contact-launcher__sr">Contact SIF FOREX HUB</span></button>`;
  document.body.append(widget);

  const launcher = widget.querySelector('.sif-contact-launcher');
  const menu = widget.querySelector('.sif-contact-menu');
  const closeButton = widget.querySelector('.sif-contact-close');
  const setContactOpen = (open, restoreFocus = false) => {
    menu.hidden = !open;
    widget.classList.toggle('is-open', open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? 'Close contact options' : 'Open contact options');
    if (open) widget.querySelector('.sif-contact-option')?.focus({ preventScroll: true });
    else if (restoreFocus) launcher.focus({ preventScroll: true });
  };

  launcher.addEventListener('click', () => {
    setContactOpen(launcher.getAttribute('aria-expanded') !== 'true');
  });
  closeButton.addEventListener('click', () => setContactOpen(false, true));
  widget.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setContactOpen(false)));
  document.addEventListener('click', (event) => {
    if (!widget.contains(event.target)) setContactOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && launcher.getAttribute('aria-expanded') === 'true') setContactOpen(false, true);
  });
})();
