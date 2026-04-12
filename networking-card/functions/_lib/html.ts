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
      width: 5.5rem; height: 5.5rem;
      border-radius: 50%;
      background: #f59e0b;
      margin: 0 auto 1.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.25rem;
    }
    h1 { font-size: 1.375rem; font-weight: 700; margin-bottom: 0.375rem; }
    .pitch { color: #9ca3af; margin-bottom: 1.75rem; font-size: 0.9375rem; line-height: 1.5; }
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
    .btn-outline {
      background: transparent;
      border: 1px solid #4b5563;
      color: #f9fafb;
      display: inline-block;
      width: auto;
      padding: 0.5rem 1.25rem;
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
    .privacy { font-size: 0.6875rem; color: #6b7280; margin-top: 1.5rem; }
    #manual-form { display: none; margin-top: 1.25rem; }
    .thanks-icon { font-size: 2.5rem; margin-bottom: 0.75rem; }
    .links { margin-top: 1.5rem; display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;
}
