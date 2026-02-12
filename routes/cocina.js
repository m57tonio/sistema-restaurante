const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireRole } = require('../middleware/auth');

// Rutas para la vista/cola de cocina
// - Renderiza pedidos/items en orden de envío (FIFO por enviado_at, luego created_at)
// - Permite avanzar estados: preparando -> listo -> servido

// GET /cocina - vista de cola de cocina
router.get('/', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE i.estado IN ('enviado','preparando','listo')
            ORDER BY COALESCE(i.enviado_at, i.created_at) ASC, i.id ASC
        `);

        res.render('cocina', { items: items || [] });
    } catch (error) {
        console.error('Error al cargar cocina:', error);
        res.status(500).render('error', { error: { message: 'Error al cargar cocina', stack: error.stack } });
    }
});

// GET /cocina/cola - API: obtener cola de cocina
router.get('/cola', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE i.estado IN ('enviado','preparando','listo')
            ORDER BY COALESCE(i.enviado_at, i.created_at) ASC, i.id ASC
        `);
        res.json(items);
    } catch (error) {
        console.error('Error al obtener cola:', error);
        res.status(500).json({ error: 'Error al obtener cola' });
    }
});

// GET /cocina/entregados - API: items entregados (servido) con filtro por fecha
// Parámetros:
// - desde=YYYY-MM-DD
// - hasta=YYYY-MM-DD
// Si no se envían, se puede filtrar desde el frontend (por defecto hoy).
// Relacionado con:
// - public/js/cocina.js (pestaña Entregados y filtros)
// - views/cocina.ejs (inputs de fecha)
router.get('/entregados', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const desde = String(req.query.desde || '').trim();
        const hasta = String(req.query.hasta || '').trim();

        const where = [`i.estado = 'servido'`];
        const params = [];

        // Validación simple de formato (YYYY-MM-DD). Si no cumple, ignoramos filtro.
        const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
        if (isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.servido_at, i.updated_at, i.created_at)) BETWEEN ? AND ?`);
            params.push(desde, hasta);
        } else if (isDate(desde) && !isDate(hasta)) {
            where.push(`DATE(COALESCE(i.servido_at, i.updated_at, i.created_at)) >= ?`);
            params.push(desde);
        } else if (!isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.servido_at, i.updated_at, i.created_at)) <= ?`);
            params.push(hasta);
        }

        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(i.servido_at, i.updated_at, i.created_at) DESC, i.id DESC
            LIMIT 500
        `, params);

        res.json(items || []);
    } catch (error) {
        console.error('Error al obtener entregados:', error);
        res.status(500).json({ error: 'Error al obtener entregados' });
    }
});

// GET /cocina/rechazados - API: items rechazados (rechazado) con filtro por fecha
// Parámetros:
// - desde=YYYY-MM-DD
// - hasta=YYYY-MM-DD
// Relacionado con:
// - public/js/cocina.js (pestaña Rechazados y filtros)
// - views/cocina.ejs (pestaña Rechazados)
// - routes/mesas.js (liberar mesa -> marca pedido/items como rechazados)
router.get('/rechazados', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const desde = String(req.query.desde || '').trim();
        const hasta = String(req.query.hasta || '').trim();

        // Tomamos rechazados desde el item (i.estado) o desde el pedido (p.estado)
        // para soportar escenarios donde el item aún quedó 'cancelado' pero el pedido fue rechazado.
        const where = [`(i.estado = 'rechazado' OR p.estado = 'rechazado')`];
        const params = [];

        // Validación simple de formato (YYYY-MM-DD). Si no cumple, ignoramos filtro.
        const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
        if (isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.updated_at, i.created_at)) BETWEEN ? AND ?`);
            params.push(desde, hasta);
        } else if (isDate(desde) && !isDate(hasta)) {
            where.push(`DATE(COALESCE(i.updated_at, i.created_at)) >= ?`);
            params.push(desde);
        } else if (!isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.updated_at, i.created_at)) <= ?`);
            params.push(hasta);
        }

        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(i.updated_at, i.created_at) DESC, i.id DESC
            LIMIT 500
        `, params);

        res.json(items || []);
    } catch (error) {
        console.error('Error al obtener rechazados:', error);
        res.status(500).json({ error: 'Error al obtener rechazados' });
    }
});

// PUT /cocina/item/:id/estado - API: actualizar estado de preparación
router.put('/item/:id/estado', requireRole(['cocinero', 'administrador']), async (req, res) => {
    try {
        const id = req.params.id;
        const { estado } = req.body || {};
        const permitidos = ['preparando','listo'];
        if (!permitidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

        const timestampField = estado === 'preparando' ? 'preparado_at' : 'listo_at';
        const [result] = await db.query(
            `UPDATE pedido_items SET estado = ?, ${timestampField} = NOW() WHERE id = ? AND estado IN ('enviado','preparando')`,
            [estado, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Item no encontrado o en estado no válido' });
        res.json({ message: 'Estado actualizado' });
    } catch (error) {
        console.error('Error al actualizar estado en cocina:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// PUT /cocina/item/:id/rechazar - API: cancelar/rechazar item desde Cocina
// Relacionado con:
// - public/js/cocina.js (botón "Cancelar" en tabs Enviados/Preparando/Listos)
// - views/cocina.ejs (pestañas)
// - database.sql (estado pedido_items='rechazado')
router.put('/item/:id/rechazar', requireRole(['cocinero', 'administrador']), async (req, res) => {
    try {
        const id = req.params.id;

        // Solo se permite rechazar items aún en cola/preparación
        const [result] = await db.query(
            `UPDATE pedido_items
             SET estado = 'rechazado'
             WHERE id = ? AND estado IN ('enviado','preparando','listo')`,
            [id]
        );

        if ((result?.affectedRows || 0) === 0) {
            return res.status(400).json({ error: 'No se pudo rechazar: item no encontrado o en estado no válido' });
        }

        res.json({ message: 'Item rechazado' });
    } catch (error) {
        console.error('Error al rechazar item en cocina:', error);
        res.status(500).json({ error: 'Error al rechazar item' });
    }
});

module.exports = router;


