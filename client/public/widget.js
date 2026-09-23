/* Dental Machine booking widget. On your website:
   <script src="https://YOUR-APP/widget.js" data-practice="your-slug" data-label="Book online" data-color="#0d9488" async></script>
   Adds a "Book online" button that opens your online booking (tagged as coming from your website). */
(function () {
  var s = document.currentScript || document.querySelector('script[data-practice][src*="widget.js"]');
  if (!s) return;
  var origin = new URL(s.src).origin;
  var slug = s.getAttribute('data-practice');
  if (!slug) return;
  var url = origin + '/book/' + encodeURIComponent(slug) + '?src=' + encodeURIComponent(s.getAttribute('data-source') || 'website');
  var b = document.createElement('button');
  b.type = 'button';
  b.textContent = s.getAttribute('data-label') || 'Book online';
  b.setAttribute('aria-label', b.textContent);
  var inline = s.getAttribute('data-inline') === 'true';
  b.style.cssText = (inline ? '' : 'position:fixed;right:20px;bottom:20px;z-index:2147483000;box-shadow:0 6px 20px rgba(0,0,0,.2);')
    + 'background:' + (s.getAttribute('data-color') || '#0d9488') + ';color:#fff;border:0;border-radius:999px;padding:14px 22px;font:600 16px/1 system-ui,sans-serif;cursor:pointer;';
  b.onclick = function () {
    if (window.innerWidth < 700) { window.location.href = url; return; }
    var w = window.open(url, 'dm-booking', 'width=520,height=820,left=' + Math.max(0, window.screenX + window.outerWidth - 560) + ',top=' + (window.screenY + 40));
    if (!w) window.location.href = url;
  };
  if (inline) s.parentNode.insertBefore(b, s); else (document.body || document.documentElement).appendChild(b);
})();
