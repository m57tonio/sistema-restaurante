// Middleware de autenticación y roles.
// Relacionado con:
// - routes/auth.js (login/logout)
// - routes/usuarios.js (solo administrador)
// - server.js (protege rutas /mesas /cocina /productos /clientes /ventas /configuracion)
// - views/partials/navbar.ejs (muestra usuario/rol)

function wantsJson(req) {
  // Detecta peticiones tipo API/AJAX para responder JSON en vez de redirigir.
  const accept = String(req.headers.accept || '').toLowerCase();
  return (
    req.xhr ||
    accept.includes('application/json') ||
    String(req.path || '').startsWith('/api/') ||
    String(req.originalUrl || '').startsWith('/api/')
  );
}

function attachUserToLocals(req, res, next) {
  // Expone el usuario en EJS como "user"
  res.locals.user = (req.session && req.session.user) ? req.session.user : null;
  next();
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'No autenticado' });
  return res.redirect('/login');
}

function requireRole(...roles) {
  // Soporta requireRole('admin') o requireRole(['a','b'])
  const flat = roles.flat().map(r => String(r || '').trim()).filter(Boolean);
  return (req, res, next) => {
    const user = req.session && req.session.user ? req.session.user : null;
    if (!user) {
      if (wantsJson(req)) return res.status(401).json({ error: 'No autenticado' });
      return res.redirect('/login');
    }
    if (flat.length === 0) return next();
    if (flat.includes(String(user.rol || '').trim())) return next();
    if (wantsJson(req)) return res.status(403).json({ error: 'No autorizado' });
    return res.status(403).render('error', {
      error: {
        message: 'No autorizado',
        stack: ''
      }
    });
  };
}

module.exports = { attachUserToLocals, requireAuth, requireRole };

