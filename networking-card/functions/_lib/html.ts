export function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} \u2014 Dazbeez</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #111827;
      color: #f9fafb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1f2937;
      border-radius: 1.5rem;
      padding: 2.5rem;
      max-width: 26rem;
      width: 100%;
      margin: 1rem;
      text-align: center;
    }
    .photo {
      width: 3.5rem; height: 3.5rem;
      border-radius: 50%;
      background: #f59e0b;
      margin: 0 auto 0.75rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
    }
    .eyebrow {
      color: #fbbf24;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 0.875rem;
    }
    h1 { font-size: 1.375rem; font-weight: 700; margin-bottom: 0.375rem; }
    h2 { font-size: 1rem; font-weight: 700; margin-bottom: 0.375rem; }
    .pitch { color: #9ca3af; margin-bottom: 1rem; font-size: 0.9375rem; line-height: 1.5; }
    .divider-label {
      color: #9ca3af;
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 1rem 0 0.5rem;
    }
    .footer-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 0.875rem;
      margin-top: 1.25rem;
      font-size: 0.75rem;
    }
    .footer-links a {
      color: #9ca3af;
      text-decoration: none;
      transition: color 0.15s;
    }
    .footer-links a:hover { color: #fbbf24; }
    .subcopy { color: #d1d5db; margin: 0.875rem 0 1.125rem; font-size: 0.8125rem; line-height: 1.5; }
    .btn {
      display: block; width: 100%;
      padding: 0.75rem 1.25rem;
      border: none; border-radius: 0.75rem;
      font-size: 0.9375rem; font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      margin-bottom: 0.625rem;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-google { background: #fff; color: #374151; }
    .btn-linkedin { background: #0a66c2; color: #fff; }
    .btn-manual { background: #374151; color: #f9fafb; }
    .btn-amber { background: #f59e0b; color: #111827; }
    .google-signin-shell {
      display: flex;
      justify-content: center;
      margin-bottom: 0.625rem;
    }
    .btn-outline {
      background: transparent;
      border: 1px solid #4b5563;
      color: #f9fafb;
      display: inline-block;
      width: auto;
      padding: 0.5rem 1.25rem;
    }
    .provider-note {
      color: #9ca3af;
      font-size: 0.8125rem;
      line-height: 1.5;
      margin: 0 0 0.875rem;
      padding: 0.75rem 1rem;
      border: 1px dashed #4b5563;
      border-radius: 0.75rem;
      text-align: left;
    }
    .form-group { margin-bottom: 0.875rem; text-align: left; }
    .form-group label { display: block; margin-bottom: 0.25rem; font-size: 0.8125rem; color: #9ca3af; }
    .form-group input {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border-radius: 0.5rem;
      border: 1px solid #374151;
      background: #111827;
      color: #f9fafb;
      font-size: 0.9375rem;
    }
    .form-group input:focus { outline: none; border-color: #f59e0b; }
    .section {
      margin-top: 1.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid #374151;
      text-align: left;
    }
    .section-copy {
      color: #9ca3af;
      font-size: 0.8125rem;
      line-height: 1.5;
      margin-bottom: 0.875rem;
    }
    .privacy { font-size: 0.6875rem; color: #6b7280; margin-top: 1.5rem; line-height: 1.5; }
    #manual-form { display: none; margin-top: 1.25rem; }
    .thanks-icon { font-size: 2.5rem; margin-bottom: 0.75rem; }
    .links { margin-top: 1.5rem; display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
    body.modal-open { overflow: hidden; }
    .sheet-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(17, 24, 39, 0.74);
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding: 1rem;
      z-index: 40;
    }
    .sheet-backdrop[hidden] { display: none; }
    .sheet-panel {
      width: 100%;
      max-width: 26rem;
      background: #fffdf7;
      color: #111827;
      border-radius: 1.5rem 1.5rem 1rem 1rem;
      padding: 1rem 1rem 1.25rem;
      box-shadow: 0 24px 64px rgba(17, 24, 39, 0.34);
      text-align: left;
    }
    .sheet-pill {
      width: 3rem;
      height: 0.25rem;
      background: #d1d5db;
      border-radius: 9999px;
      margin: 0 auto 0.875rem;
    }
    .sheet-eyebrow {
      color: #b45309;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    .sheet-copy, .sheet-note {
      color: #4b5563;
      font-size: 0.8125rem;
      line-height: 1.55;
    }
    .sheet-note { margin-top: 0.875rem; }
    .sheet-section {
      margin-top: 1rem;
      padding-top: 0.875rem;
      border-top: 1px solid #e5e7eb;
    }
    .sheet-section h3 {
      font-size: 0.875rem;
      font-weight: 700;
      margin-bottom: 0.625rem;
    }
    .detail-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.625rem 0.75rem;
      border-radius: 0.875rem;
      background: #ffffff;
      border: 1px solid #f3f4f6;
    }
    .detail-label {
      color: #6b7280;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex: 0 0 6rem;
    }
    .detail-value {
      color: #111827;
      font-size: 0.8125rem;
      line-height: 1.45;
      text-align: right;
      word-break: break-word;
    }
    .sheet-close { margin-top: 1rem; margin-bottom: 0; }
    @media (max-width: 480px) {
      .detail-row {
        flex-direction: column;
        align-items: flex-start;
      }
      .detail-value {
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
  <script>
    (function () {
      var triggers = document.querySelectorAll('[data-vcard-download]');
      var sheet = document.getElementById('vcard-sheet');
      if (!triggers.length || !sheet) return;

      var closeButton = sheet.querySelector('[data-vcard-sheet-close]');

      function openSheet() {
        sheet.hidden = false;
        sheet.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
      }

      function closeSheet() {
        sheet.hidden = true;
        sheet.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
      }

      triggers.forEach(function (trigger) {
        trigger.addEventListener('click', function () {
          window.setTimeout(openSheet, 180);
        });
      });

      if (closeButton) {
        closeButton.addEventListener('click', closeSheet);
      }

      sheet.addEventListener('click', function (event) {
        if (event.target === sheet) {
          closeSheet();
        }
      });

      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          closeSheet();
        }
      });
    })();
  </script>
</body>
</html>`;
}
