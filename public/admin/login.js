const form = document.getElementById('login-form');
const err = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  err.hidden = true;

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? 'Could not sign in.');
    // The session cookie is set server-side; reload to get the dashboard.
    window.location.replace('/admin');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Sign in';
    document.getElementById('password').select();
  }
});
