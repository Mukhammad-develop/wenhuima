/* Arrow icons */
window.SITE_ICONS = {"leftwards-arrow": "<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 32 32\" height=\"32\" width=\"32\" part=\"svg\"> <path part=\"base-color\" fill=\"currentColor\" d=\"M 28.04 17.12 L 28.04 14.88 L 10.75 14.88 L 7.83 15.01 L 10.19 12.99 L 14.55 8.70 L 13.02 7.16 L 3.96 15.99 L 13.02 24.84 L 14.55 23.28 L 10.16 19.00 L 7.82 16.97 L 10.75 17.12 L 28.04 17.12 Z\"></path> </svg>", "rotating-arrow-left": "<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 32 32\" height=\"32\" width=\"32\" part=\"svg\"> <path part=\"base-color\" fill=\"currentColor\" d=\"M 16.43 15.72 L 17.73 14.41 L 13.63 10.34 C 14.41 10.19 15.20 10.12 16.00 10.13 C 17.63 10.13 19.23 10.61 20.59 11.52 C 21.94 12.43 23.00 13.72 23.63 15.23 C 24.25 16.74 24.41 18.40 24.09 20.00 C 23.77 21.60 22.99 23.08 21.83 24.23 C 20.67 25.38 19.20 26.17 17.60 26.49 C 16.00 26.80 14.33 26.64 12.83 26.01 C 11.32 25.38 10.03 24.32 9.12 22.96 C 8.22 21.60 7.74 20.01 7.74 18.37 C 7.74 17.82 7.74 17.41 7.74 17.41 H 5.91 C 5.91 17.41 5.91 18.08 5.91 18.37 C 5.91 20.37 6.50 22.32 7.61 23.98 C 8.71 25.64 10.29 26.93 12.13 27.70 C 13.98 28.46 16.00 28.66 17.96 28.27 C 19.92 27.89 21.72 26.93 23.13 25.52 C 24.54 24.11 25.50 22.31 25.89 20.35 C 26.28 18.40 26.09 16.37 25.32 14.52 C 24.56 12.68 23.27 11.10 21.61 9.99 C 19.95 8.88 18.00 8.29 16.01 8.29 C 15.34 8.29 14.68 8.35 14.02 8.47 L 17.71 4.85 L 16.38 3.53 L 10.38 9.62 L 16.43 15.72 Z\"></path> </svg>", "rightwards-arrow": "<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 32 32\" height=\"32\" width=\"32\" part=\"svg\"> <path part=\"base-color\" fill=\"currentColor\" d=\"M 3.96 17.12 L 3.96 14.88 L 21.25 14.88 L 24.17 15.01 L 21.81 12.99 L 17.45 8.70 L 18.98 7.16 L 28.04 15.99 L 18.98 24.84 L 17.45 23.28 L 21.84 19.00 L 24.18 16.97 L 21.25 17.12 L 3.96 17.12 Z\"></path> </svg>"};
/*
 * Layout engine for the static copy of the portfolio.
 * Re-implements the parts of Cargo's page layout this site uses:
 * viewport-based sizing, column sets, free-form / grid galleries,
 * slideshows, media (images + videos), text icons, wallpapers and
 * the click-to-zoom image viewer.
 */
(function () {
  'use strict';

  const MEDIA = window.SITE_MEDIA || {};
  const ICONS = window.SITE_ICONS || {};
  const root = document.documentElement;

  /* ---------- viewport sizing (same formula Cargo uses) ---------- */
  const mqPortrait = matchMedia('(max-aspect-ratio: 4/5)');
  const mqLandscape = matchMedia('(min-aspect-ratio: 2/3) and (max-height: 500px)');
  let isMobile = false;

  function sizeViewport() {
    const w = root.clientWidth, h = window.innerHeight;
    const mobile = mqPortrait.matches || mqLandscape.matches;
    let tall = 0;
    if (h > w) tall = Math.min(1, (h / w - 1) / 0.777777778);
    const weight = (mobile && !mqPortrait.matches ? 18 : 9) + 5 * tall;
    const unit = Math.max(20, Math.min(w, h) * weight / 100);
    root.style.setProperty('--base-size', unit * 0.16 + 'px');
    root.style.setProperty('--viewport-height', h + 'px');
    root.style.setProperty('--min-viewport-height', h + 'px');
    root.style.setProperty('--visible-viewport-height', h + 'px');
    if (mobile !== isMobile) {
      isMobile = mobile;
      root.classList.toggle('mobile', mobile);
      document.body && document.body.classList.toggle('mobile', mobile);
      document.dispatchEvent(new Event('site:mobile-change'));
    }
  }
  sizeViewport();
  addEventListener('resize', sizeViewport);
  mqPortrait.addEventListener('change', sizeViewport);
  mqLandscape.addEventListener('change', sizeViewport);

  const rem = v => {
    v = String(v == null ? '' : v).trim();
    if (v === '') return null;
    return /^-?[\d.]+$/.test(v) ? v + 'rem' : v;
  };
  const isEmpty = el => ![...el.childNodes].some(n => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim()));

  /* ---------- column-set ---------- */
  class ColumnSet extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.attachShadow({ mode: 'open' });
      this.render();
      document.addEventListener('site:mobile-change', () => this.render());
    }
    render() {
      const units = [...this.children].filter(c => c.localName === 'column-unit');
      const gutter = rem(this.getAttribute('gutter')) || '1rem';
      const stack = this.getAttribute('mobile-stack') !== 'false';
      const hideEmpty = this.getAttribute('mobile-hide-empty') === 'true';
      const mGutter = rem(this.getAttribute('mobile-gutter'));
      units.forEach((u, i) => u.setAttribute('slot', i));
      let css = '';
      if (isMobile && stack) {
        const g = `calc(var(--mobile-padding-offset, 1) * ${mGutter || gutter})`;
        const shown = units.map(u => !(isEmpty(u) && (hideEmpty || stack)));
        const last = shown.lastIndexOf(true);
        css = `:host{display:flex;flex-direction:column;align-items:start;width:100%;position:relative;clear:both;margin-top:calc(var(--gutter-expand, 0) * ${g})}
          ::slotted(column-unit){display:block;word-wrap:break-word;position:relative;max-width:100%;width:100%;flex:0 0 auto}`;
        units.forEach((u, i) => {
          if (!shown[i]) css += `::slotted(column-unit[slot="${i}"]){display:none}`;
          else if (i < last) css += `::slotted(column-unit[slot="${i}"]){margin-bottom:${g}}`;
        });
      } else {
        const g = isMobile && mGutter ? `calc(var(--mobile-padding-offset, 1) * ${mGutter})` : gutter;
        const spans = units.map(u => parseInt(u.getAttribute('span')) || 0);
        const uniform = spans.every(s => !s);
        const total = uniform ? units.length : Math.max(units.length, 12);
        css = `:host{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:stretch;width:100%;position:relative;clear:both;--g:${g};margin-top:calc(var(--gutter-expand, 0) * var(--g))}
          ::slotted(column-unit){display:block;word-wrap:break-word;position:relative;max-width:100%;flex-grow:0;flex-shrink:0}
          ::slotted(column-unit:not(:last-child)){margin-right:var(--g)}
          ::slotted(column-unit:last-child){flex-grow:1}`;
        units.forEach((u, i) => {
          const s = spans[i] || 1;
          const width = `calc((100% + var(--g)) * ${s / total} - var(--g))`;
          css += `::slotted(column-unit[slot="${i}"]){flex-basis:${width};width:${width}}`;
        });
      }
      this.shadowRoot.innerHTML = `<style>${css}</style>` + units.map((_, i) => `<slot name="${i}"></slot>`).join('');
    }
  }

  /* ---------- media-item ---------- */
  const MEDIA_CSS = `
    :host{display:inline-flex;vertical-align:bottom;flex-direction:column;position:relative;width:100%;
      transform-origin:center center;margin:0;padding:0;z-index:var(--z-index,initial);
      transform:var(--base-translate, translate(0)) var(--rotate-transform, translate(0))}
    :host,*{box-sizing:border-box}
    figure{flex-direction:column;position:relative;display:flex;width:100%;margin:0;padding:0;z-index:2}
    .sizing-frame{display:block;width:100%;flex-grow:1;height:0;padding-bottom:var(--frame-padding,56.25%);position:relative}
    [part~="media"],[part~="video"],[part~="poster"]{object-fit:var(--object-fit,cover);object-position:var(--frame-position,center center);
      display:block;margin:0;width:100%;height:100%;position:absolute;inset:0}
    :host(.zoomable) [part~="media"]{cursor:zoom-in}
    .play{position:absolute;inset:0;margin:auto;width:56px;height:56px;border-radius:50%;background:rgba(87,87,87,.35);
      display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:3}
    .play svg{width:22px;height:22px;fill:rgba(255,255,255,.9);margin-left:4px}
    :host([playing]) .play{display:none}`;

  class MediaItem extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      const hash = this.getAttribute('hash');
      const m = MEDIA[hash];
      this.attachShadow({ mode: 'open' });
      if (!m) return;
      let extra = '';
      const scale = parseFloat(this.getAttribute('scale'));
      if (!this.closest('gallery-freeform') && scale && scale < 100) extra += `:host{max-width:${scale}%}`;
      const ms = this.getAttribute('media-style');
      if (ms) extra += `[part~="media"]{${ms.replace(/;\s*/g, '!important;').replace(/!important!important/g, '!important')}}`;
      const rot = parseFloat(this.getAttribute('rotation'));
      const anim = parseFloat(this.getAttribute('animate'));
      if (rot && !anim) extra += `:host{--rotate-transform: rotate(${rot}deg)}`;
      if (anim) {
        const from = rot || 0;
        extra += `@keyframes rotate{from{transform:var(--base-translate, translate(0)) rotate(${from}deg)}
          to{transform:var(--base-translate, translate(0)) rotate(${from + 360}deg)}}
          :host{animation:rotate ${50 / anim}s linear infinite;will-change:transform}`;
      }
      const pad = (m.h / m.w) * 100;
      let media;
      if (m.video) {
        const auto = this.getAttribute('autoplay') === 'true';
        const loop = this.getAttribute('loop') !== 'false';
        const poster = this.getAttribute('poster') && MEDIA[this.getAttribute('poster')];
        media = `<video part="media video" playsinline muted ${loop ? 'loop' : ''} ${auto ? 'autoplay' : ''} preload="${auto ? 'auto' : 'metadata'}"
          ${poster ? `poster="${poster.src}"` : ''} src="${m.src}"></video>` +
          (auto ? '' : `<div class="play" part="play"><svg viewBox="0 0 24 24"><path d="M5 3l16 9-16 9z"/></svg></div>`);
        if (auto) this.setAttribute('playing', '');
      } else {
        media = `<img part="media" src="${m.src}" width="${m.w}" height="${m.h}" alt="" loading="lazy" decoding="async">`;
      }
      this.shadowRoot.innerHTML = `<style>${MEDIA_CSS}${extra}</style>
        <figure part="figure"><div part="frame" class="frame"><div part="sizing-frame" class="sizing-frame" style="--frame-padding:${pad}%">${media}</div></div>
        <slot name="caption"></slot></figure>`;
      const video = this.shadowRoot.querySelector('video');
      if (video) {
        const play = this.shadowRoot.querySelector('.play');
        if (play) play.addEventListener('click', e => { e.stopPropagation(); video.play(); this.setAttribute('playing', ''); });
        if (video.autoplay) video.play().catch(() => {});
      }
      if (this.classList.contains('zoomable') && this.getAttribute('disable-zoom') !== 'true' && !m.video) {
        this.shadowRoot.querySelector('[part~="media"]').addEventListener('click', () => QuickView.open(this));
      }
    }
  }

  /* ---------- gallery-freeform (desktop collage, 2-column grid on phones) ---------- */
  class GalleryFreeform extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.attachShadow({ mode: 'open' });
      this.render();
      document.addEventListener('site:mobile-change', () => this.render());
    }
    render() {
      const items = [...this.children].filter(c => c.localName === 'media-item');
      items.forEach((it, i) => it.setAttribute('slot', 's' + i));
      let css;
      if (isMobile) {
        const gutter = rem(this.getAttribute('mobile-gutter')) || '2rem';
        const g = `calc(var(--mobile-padding-offset, 1) * ${gutter})`;
        css = `:host{display:flex;flex-wrap:wrap;width:100%;position:relative;--g:${g};row-gap:var(--g);column-gap:var(--g);margin-top:calc(var(--gutter-expand, 0) * var(--g))}
          ::slotted(media-item){position:relative;flex:1 1 calc(50% - var(--g)/2);max-width:calc(50% - var(--g)/2);--base-translate:translate(0)}
          ::slotted(media-item:last-child:nth-child(odd)){max-width:calc(50% - var(--g)/2)}`;
        items.forEach((it, i) => {
          if ((parseInt(it.getAttribute('grid-span')) || 1) >= 2) css += `::slotted(media-item[slot="s${i}"]){flex-basis:100%!important;max-width:100%!important}`;
        });
      } else {
        let height = 0;
        css = `:host{display:block;width:100%;position:relative;container-type:inline-size}
          ::slotted(media-item){position:absolute;top:0;left:0;max-width:none;display:flex}`;
        items.forEach((it, i) => {
          const m = MEDIA[it.getAttribute('hash')] || { w: 16, h: 9 };
          const s = parseFloat(it.getAttribute('freeform-scale')) || parseFloat(it.getAttribute('scale')) || 100;
          const x = parseFloat(it.getAttribute('freeform-x')) || 0;
          const y = parseFloat(it.getAttribute('freeform-y')) || 0;
          const z = (parseInt(it.getAttribute('freeform-z')) || 0) + 1;
          height = Math.max(height, y + s * m.h / m.w);
          css += `::slotted(media-item[slot="s${i}"]){width:${s}cqw;--base-translate:translate(${x}cqw, ${y}cqw);--z-index:${z}}`;
        });
        css += `.spacer{padding-bottom:${height}%}`;
      }
      this.shadowRoot.innerHTML = `<style>${css}</style>` + (isMobile ? '' : '<div class="spacer"></div>') +
        items.map((_, i) => `<slot name="s${i}"></slot>`).join('');
    }
  }

  /* ---------- gallery-grid ---------- */
  class GalleryGrid extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.attachShadow({ mode: 'open' });
      this.render();
      document.addEventListener('site:mobile-change', () => this.render());
    }
    render() {
      const items = [...this.children].filter(c => c.localName === 'media-item');
      const cols = parseInt(this.getAttribute(isMobile && this.hasAttribute('mobile-columns') ? 'mobile-columns' : 'columns')) || 3;
      const gutter = isMobile ? `calc(var(--mobile-padding-offset, 1) * ${rem(this.getAttribute('mobile-gutter')) || '1rem'})`
        : (rem(this.getAttribute('gutter')) || '1rem');
      const align = { left: 'flex-start', center: 'center', right: 'flex-end' }[this.getAttribute('horizontal-align')] || 'flex-start';
      items.forEach((it, i) => it.setAttribute('slot', 'g' + i));
      let css = `:host{display:flex;flex-wrap:wrap;width:100%;position:relative;--g:${gutter};margin-top:calc(var(--gutter-expand, 0) * var(--g));column-gap:var(--g);row-gap:var(--g);justify-content:${align};align-items:flex-${this.getAttribute('vertical-align') === 'bottom' ? 'end' : 'start'}}
        ::slotted(media-item){position:relative;display:flex}`;
      items.forEach((it, i) => {
        const span = Math.min(cols, parseInt(it.getAttribute('grid-span')) || 1);
        const w = `calc((100% + var(--g)) * ${span / cols} - var(--g))`;
        css += `::slotted(media-item[slot="g${i}"]){flex:0 0 ${w};width:${w}}`;
      });
      this.shadowRoot.innerHTML = `<style>${css}</style>` + items.map((_, i) => `<slot name="g${i}"></slot>`).join('');
    }
  }

  /* ---------- gallery-slideshow ---------- */
  const ARROW = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  class GallerySlideshow extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.attachShadow({ mode: 'open' });
      this.items = [...this.children].filter(c => c.localName === 'media-item');
      this.index = 0;
      const first = MEDIA[this.items[0] && this.items[0].getAttribute('hash')] || { w: 16, h: 9 };
      this.shadowRoot.innerHTML = `<style>
        :host{display:block;position:relative;width:100%}
        .stage{position:relative;width:100%;padding-bottom:${first.h / first.w * 100}%;overflow:hidden}
        ::slotted(media-item){position:absolute!important;inset:0;margin:auto;opacity:0;transition:opacity .4s ease;pointer-events:none;--object-fit:contain}
        ::slotted(media-item.active){opacity:1;pointer-events:auto}
        button{position:absolute;top:0;bottom:0;margin:auto;width:var(--button-size,30px);height:var(--button-size,30px);border:0;padding:0;
          border-radius:var(--button-background-radius,50%);background:var(--button-background-color,rgba(87,87,87,.35));
          color:var(--button-icon-color,rgba(255,255,255,.9));cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center}
        button:active{opacity:var(--button-active-opacity,.7)}
        button svg{width:55%;height:55%}
        .prev{left:var(--button-inset,15px)} .next{right:var(--button-inset,15px)}
      </style><div class="stage" part="slideshow"><slot></slot>
        <button class="prev" part="slideshow-nav" aria-label="Previous">${ARROW('M15 5l-7 7 7 7')}</button>
        <button class="next" part="slideshow-nav" aria-label="Next">${ARROW('M9 5l7 7-7 7')}</button></div>`;
      this.shadowRoot.querySelector('.prev').onclick = () => this.go(-1);
      this.shadowRoot.querySelector('.next').onclick = () => this.go(1);
      this.items.forEach(it => it.style.setProperty('--frame-padding', '0'));
      this.go(0);
    }
    go(d) {
      this.index = (this.index + d + this.items.length) % this.items.length;
      this.items.forEach((it, i) => it.classList.toggle('active', i === this.index));
    }
  }

  /* ---------- text-icon ---------- */
  class TextIcon extends HTMLElement {
    connectedCallback() {
      if (this._init) return; this._init = true;
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>
        :host{aspect-ratio:1;height:1.2em;width:auto;contain:layout;margin-top:-1em;margin-bottom:-.25em;display:inline-block;vertical-align:baseline;position:relative}
        svg{display:block;position:absolute;inset:0;width:100%;height:100%;fill:currentColor}</style>${ICONS[this.getAttribute('icon')] || ''}`;
    }
  }

  /* ---------- wallpaper backdrop ---------- */
  function initWallpaper() {
    document.querySelectorAll('.wallpaper[data-hash]').forEach(el => {
      const m = MEDIA[el.dataset.hash];
      if (!m) return;
      const pos = el.dataset.position || 'center center';
      el.querySelector('.image-container').innerHTML = m.video
        ? `<video src="${m.src}" autoplay muted loop playsinline style="object-position:${pos}"></video>`
        : `<img src="${m.src}" alt="" style="object-position:${pos}">`;
      const v = el.querySelector('video'); if (v) v.play().catch(() => {});
    });
  }

  /* ---------- quick view (click to zoom) ---------- */
  const QuickView = {
    open(item) {
      const list = [...document.querySelectorAll('media-item.zoomable')].filter(i =>
        i.getAttribute('disable-zoom') !== 'true' && MEDIA[i.getAttribute('hash')] && !MEDIA[i.getAttribute('hash')].video);
      let idx = Math.max(0, list.indexOf(item));
      const wrap = document.createElement('div');
      wrap.className = 'site-quick-view';
      wrap.innerHTML = `<div class="quick-view-background"></div><div class="qv-stage"><img alt=""></div>
        ${list.length > 1 ? `<button class="qv-prev" aria-label="Previous">${ARROW('M15 5l-7 7 7 7')}</button><button class="qv-next" aria-label="Next">${ARROW('M9 5l7 7-7 7')}</button>` : ''}`;
      const img = wrap.querySelector('img');
      const show = () => { img.src = MEDIA[list[idx].getAttribute('hash')].src; };
      const close = () => { wrap.remove(); removeEventListener('keydown', key); document.body.classList.remove('no-scroll'); };
      const key = e => {
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowRight') { idx = (idx + 1) % list.length; show(); }
        if (e.key === 'ArrowLeft') { idx = (idx - 1 + list.length) % list.length; show(); }
      };
      wrap.addEventListener('click', e => {
        if (e.target.closest('.qv-prev')) { idx = (idx - 1 + list.length) % list.length; show(); return; }
        if (e.target.closest('.qv-next')) { idx = (idx + 1) % list.length; show(); return; }
        close();
      });
      addEventListener('keydown', key);
      show();
      document.body.appendChild(wrap);
      document.body.classList.add('no-scroll');
    }
  };

  // Define elements once the page is parsed, so each one sees its children.
  function start() {
    document.body.classList.toggle('mobile', isMobile);
    customElements.define('column-set', ColumnSet);
    customElements.define('media-item', MediaItem);
    customElements.define('gallery-freeform', GalleryFreeform);
    customElements.define('gallery-grid', GalleryGrid);
    customElements.define('gallery-slideshow', GallerySlideshow);
    customElements.define('text-icon', TextIcon);
    initWallpaper();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
