const express = require('express');
const router = express.Router();
const db = require('../db');

// Rutas para gestión de mesas y pedidos de restaurante
// - Renderiza la vista de mesas (GET /mesas)
// - Expone endpoints para abrir pedidos por mesa, agregar items y enviarlos a cocina
// - Se monta en server.js tanto en '/mesas' como en '/api/mesas'

// Sincroniza estado de mesa en función de items activos:
// - Si no hay items activos en pedidos abiertos => libre
// - Si hay items activos => ocupada
// Relacionado con:
// - views/mesas.ejs (badge de estado)
// - public/js/mesas.js (refreshMesas)
// - requerimiento funcional: evitar mesas "ocupadas" sin productos
async function syncMesaEstadoByItems(connection, mesaId) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS cnt
         FROM pedido_items i
         JOIN pedidos p ON p.id = i.pedido_id
         WHERE p.mesa_id = ?
           AND p.estado NOT IN ('cerrado','cancelado','rechazado')
           AND i.estado NOT IN ('cancelado','rechazado')`,
        [mesaId]
    );
    const activos = Number(rows?.[0]?.cnt || 0);
    await connection.query(
        `UPDATE mesas
         SET estado = ?
         WHERE id = ?
           AND estado IN ('libre','ocupada')`,
        [activos > 0 ? 'ocupada' : 'libre', mesaId]
    );
}

// Obtiene mesa_id de un item para operaciones posteriores (ej. sincronizar estado).
// Relacionado con: syncMesaEstadoByItems() y rutas de actualización/eliminación de items.
async function getMesaIdByItem(connection, itemId) {
    const [rows] = await connection.query(
        `SELECT p.mesa_id
         FROM pedido_items i
         JOIN pedidos p ON p.id = i.pedido_id
         WHERE i.id = ?
         LIMIT 1`,
        [itemId]
    );
    if (!rows.length) return null;
    return rows[0].mesa_id;
}

// GET /mesas - Página de gestión de mesas
router.get('/', async (req, res) => {
    try {
        // Trae el listado de mesas y si tienen pedidos abiertos (para mostrar estado)
        const [mesas] = await db.query(`
            SELECT m.*,
            (
                SELECT COUNT(*) FROM pedidos p 
                -- 'rechazado' se considera finalizado (no pedido activo)
                -- Relacionado con: estado "rechazado" solicitado (ver database.sql)
                WHERE p.mesa_id = m.id AND p.estado NOT IN ('cerrado','cancelado','rechazado')
            ) AS pedidos_abiertos,
            (
                SELECT COUNT(*)
                FROM pedido_items i
                JOIN pedidos p2 ON p2.id = i.pedido_id
                WHERE p2.mesa_id = m.id
                  AND p2.estado NOT IN ('cerrado','cancelado','rechazado')
                  AND i.estado NOT IN ('cancelado','rechazado')
            ) AS items_activos,
            CASE
                WHEN m.estado IN ('reservada','bloqueada') THEN m.estado
                WHEN (
                    SELECT COUNT(*)
                    FROM pedido_items i2
                    JOIN pedidos p3 ON p3.id = i2.pedido_id
                    WHERE p3.mesa_id = m.id
                      AND p3.estado NOT IN ('cerrado','cancelado','rechazado')
                      AND i2.estado NOT IN ('cancelado','rechazado')
                ) > 0 THEN 'ocupada'
                ELSE 'libre'
            END AS estado
            FROM mesas m
            ORDER BY m.numero
        `);

        res.render('mesas', { mesas: mesas || [] });
    } catch (error) {
        console.error('Error al cargar mesas:', error);
        res.status(500).render('error', { 
            error: { message: 'Error al cargar mesas', stack: error.stack }
        });
    }
});

// GET /mesas/listar - API: lista de mesas con estado actual
router.get('/listar', async (req, res) => {
    try {
        const [mesas] = await db.query(`
            SELECT m.*,
            (
                SELECT COUNT(*) FROM pedidos p 
                -- 'rechazado' se considera finalizado (no pedido activo)
                -- Relacionado con: estado "rechazado" solicitado (ver database.sql)
                WHERE p.mesa_id = m.id AND p.estado NOT IN ('cerrado','cancelado','rechazado')
            ) AS pedidos_abiertos,
            (
                SELECT COUNT(*)
                FROM pedido_items i
                JOIN pedidos p2 ON p2.id = i.pedido_id
                WHERE p2.mesa_id = m.id
                  AND p2.estado NOT IN ('cerrado','cancelado','rechazado')
                  AND i.estado NOT IN ('cancelado','rechazado')
            ) AS items_activos,
            CASE
                WHEN m.estado IN ('reservada','bloqueada') THEN m.estado
                WHEN (
                    SELECT COUNT(*)
                    FROM pedido_items i2
                    JOIN pedidos p3 ON p3.id = i2.pedido_id
                    WHERE p3.mesa_id = m.id
                      AND p3.estado NOT IN ('cerrado','cancelado','rechazado')
                      AND i2.estado NOT IN ('cancelado','rechazado')
                ) > 0 THEN 'ocupada'
                ELSE 'libre'
            END AS estado
            FROM mesas m
            ORDER BY m.numero
        `);
        res.json(mesas);
    } catch (error) {
        console.error('Error al listar mesas:', error);
        res.status(500).json({ error: 'Error al listar mesas' });
    }
});

// POST /mesas/crear - API: crear mesa (opcional, para administración rápida)
router.post('/crear', async (req, res) => {
    try {
        const { numero, descripcion } = req.body || {};
        if (!numero) return res.status(400).json({ error: 'El número de mesa es requerido' });
        const [result] = await db.query(
            'INSERT INTO mesas (numero, descripcion, estado) VALUES (?, ?, ?)',
            [String(numero), descripcion || null, 'libre']
        );
        res.status(201).json({ id: result.insertId });
    } catch (error) {
        console.error('Error al crear mesa:', error);
        res.status(500).json({ error: 'Error al crear mesa' });
    }
});

// PUT /mesas/:mesaId - API: editar mesa (numero/descripcion/estado)
router.put('/:mesaId', async (req, res) => {
    try {
        const mesaId = req.params.mesaId;
        const { numero, descripcion, estado } = req.body || {};

        if (!numero) return res.status(400).json({ error: 'El número de mesa es requerido' });

        const estadosPermitidos = ['libre', 'ocupada', 'reservada', 'bloqueada'];
        if (estado && !estadosPermitidos.includes(estado)) {
            return res.status(400).json({ error: 'Estado inválido' });
        }

        // Validar existencia
        const [actual] = await db.query('SELECT id FROM mesas WHERE id = ?', [mesaId]);
        if (actual.length === 0) return res.status(404).json({ error: 'Mesa no encontrada' });

        // Validar número único
        const [duplicada] = await db.query('SELECT id FROM mesas WHERE numero = ? AND id <> ?', [String(numero), mesaId]);
        if (duplicada.length > 0) {
            return res.status(409).json({ error: 'Ya existe una mesa con ese número' });
        }

        await db.query(
            'UPDATE mesas SET numero = ?, descripcion = ?, estado = COALESCE(?, estado) WHERE id = ?',
            [String(numero), descripcion || null, estado || null, mesaId]
        );

        res.json({ message: 'Mesa actualizada' });
    } catch (error) {
        console.error('Error al editar mesa:', error);
        res.status(500).json({ error: 'Error al editar mesa' });
    }
});

// DELETE /mesas/:mesaId - API: eliminar mesa (solo si no tiene pedidos asociados)
router.delete('/:mesaId', async (req, res) => {
    try {
        const mesaId = req.params.mesaId;

        const [existe] = await db.query('SELECT id FROM mesas WHERE id = ?', [mesaId]);
        if (existe.length === 0) return res.status(404).json({ error: 'Mesa no encontrada' });

        const [pedidos] = await db.query('SELECT COUNT(*) AS cnt FROM pedidos WHERE mesa_id = ?', [mesaId]);
        const cnt = Number(pedidos?.[0]?.cnt || 0);
        if (cnt > 0) {
            return res.status(400).json({ error: 'No se puede eliminar: la mesa tiene pedidos asociados' });
        }

        const [result] = await db.query('DELETE FROM mesas WHERE id = ?', [mesaId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Mesa no encontrada' });

        res.json({ message: 'Mesa eliminada' });
    } catch (error) {
        console.error('Error al eliminar mesa:', error);
        res.status(500).json({ error: 'Error al eliminar mesa' });
    }
});

// POST /mesas/abrir - API: abre (o recupera) pedido abierto para una mesa
router.post('/abrir', async (req, res) => {
    const { mesa_id, cliente_id, notas } = req.body || {};
    if (!mesa_id) return res.status(400).json({ error: 'mesa_id requerido' });
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [existentes] = await connection.query(
                // Nota: 'rechazado' NO es pedido activo; no se debe reutilizar al abrir
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT * FROM pedidos WHERE mesa_id = ? AND estado NOT IN ('cerrado','cancelado','rechazado') LIMIT 1`,
                [mesa_id]
            );
            if (existentes.length > 0) {
                await syncMesaEstadoByItems(connection, mesa_id);
                await connection.commit();
                connection.release();
                return res.json({ pedido: existentes[0] });
            }

            const [insert] = await connection.query(
                `INSERT INTO pedidos (mesa_id, cliente_id, estado, total, notas) VALUES (?, ?, 'abierto', 0, ?)` ,
                [mesa_id, cliente_id || null, notas || null]
            );

            // Importante: abrir pedido no fuerza "ocupada" si aún no hay items.
            // La mesa cambia automáticamente según el conteo real de productos.
            await syncMesaEstadoByItems(connection, mesa_id);

            await connection.commit();
            connection.release();
            res.status(201).json({ pedido: { id: insert.insertId, mesa_id, cliente_id: cliente_id || null, estado: 'abierto', total: 0, notas: notas || null } });
        } catch (error) {
            await connection.rollback();
            connection.release();
            throw error;
        }
    } catch (error) {
        console.error('Error al abrir pedido:', error);
        res.status(500).json({ error: 'Error al abrir pedido' });
    }
});

// GET /mesas/pedidos/:pedidoId - API: obtener pedido con items
router.get('/pedidos/:pedidoId', async (req, res) => {
    try {
        const pedidoId = req.params.pedidoId;
        const [pedidos] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
        if (pedidos.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });
        const pedido = pedidos[0];
        const [items] = await db.query(`
            SELECT i.*, p.nombre AS producto_nombre 
            FROM pedido_items i
            JOIN productos p ON p.id = i.producto_id
            WHERE i.pedido_id = ?
            ORDER BY i.created_at ASC
        `, [pedidoId]);
        res.json({ pedido, items });
    } catch (error) {
        console.error('Error al obtener pedido:', error);
        res.status(500).json({ error: 'Error al obtener pedido' });
    }
});

// POST /mesas/pedidos/:pedidoId/items - API: agregar item al pedido
router.post('/pedidos/:pedidoId/items', async (req, res) => {
    try {
        const pedidoId = req.params.pedidoId;
        const { producto_id, cantidad, unidad, precio, nota } = req.body || {};
        if (!producto_id || !cantidad || !precio) {
            return res.status(400).json({ error: 'producto_id, cantidad y precio son requeridos' });
        }
        const subtotal = Number(cantidad) * Number(precio);
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [result] = await connection.query(
                `INSERT INTO pedido_items (pedido_id, producto_id, cantidad, unidad_medida, precio_unitario, subtotal, estado, nota)
                 VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)` ,
                [pedidoId, producto_id, cantidad, unidad || 'UND', precio, subtotal, nota || null]
            );
            const [pedidoRows] = await connection.query('SELECT mesa_id FROM pedidos WHERE id = ? LIMIT 1', [pedidoId]);
            if (pedidoRows.length > 0) {
                await syncMesaEstadoByItems(connection, pedidoRows[0].mesa_id);
            }
            await connection.commit();
            connection.release();
            res.status(201).json({ id: result.insertId });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al agregar item:', error);
        res.status(500).json({ error: 'Error al agregar item' });
    }
});

// PUT /mesas/items/:itemId - API: editar item del pedido (solo pendiente y antes de enviar)
// Relacionado con:
// - public/js/mesas.js (botón "Editar" en cada item pendiente)
// - requerimiento funcional: poder editar antes de enviar a cocina
router.put('/items/:itemId', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const { cantidad, nota } = req.body || {};
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [rows] = await connection.query(
                `SELECT i.id, i.estado, i.cantidad, i.precio_unitario, i.nota
                 FROM pedido_items i
                 WHERE i.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [itemId]
            );
            if (!rows.length) {
                throw new Error('Item no encontrado');
            }
            const actual = rows[0];
            if (String(actual.estado || '').toLowerCase() !== 'pendiente') {
                throw new Error('Solo se pueden editar items pendientes (antes de enviar a cocina)');
            }

            const nuevaCantidad = (cantidad != null && cantidad !== '') ? Number(cantidad) : Number(actual.cantidad || 0);
            if (!Number.isFinite(nuevaCantidad) || nuevaCantidad <= 0) {
                throw new Error('La cantidad debe ser mayor a 0');
            }
            const nuevaNota = (nota != null) ? String(nota).trim() : String(actual.nota || '').trim();
            const precio = Number(actual.precio_unitario || 0);
            const subtotal = nuevaCantidad * precio;

            await connection.query(
                `UPDATE pedido_items
                 SET cantidad = ?, subtotal = ?, nota = ?
                 WHERE id = ? AND estado = 'pendiente'`,
                [nuevaCantidad, subtotal, nuevaNota || null, itemId]
            );

            const mesaId = await getMesaIdByItem(connection, itemId);
            if (mesaId) {
                await syncMesaEstadoByItems(connection, mesaId);
            }

            await connection.commit();
            connection.release();
            res.json({ message: 'Item actualizado' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            const msg = String(err?.message || 'Error al editar item');
            if (msg.includes('no encontrado')) {
                return res.status(404).json({ error: msg });
            }
            if (msg.includes('pendientes') || msg.includes('cantidad')) {
                return res.status(400).json({ error: msg });
            }
            throw err;
        }
    } catch (error) {
        console.error('Error al editar item:', error);
        res.status(500).json({ error: 'Error al editar item' });
    }
});

// DELETE /mesas/items/:itemId - API: eliminar item del pedido
// Relacionado con: public/js/mesas.js (función eliminarItem)
// IMPORTANTE: solo permite eliminar items en estado "pendiente"
router.delete('/items/:itemId', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        console.log(`DELETE /api/mesas/items/${itemId} - Eliminando item`);
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [itemRows] = await connection.query(
                `SELECT i.id, i.estado, p.mesa_id
                 FROM pedido_items i
                 JOIN pedidos p ON p.id = i.pedido_id
                 WHERE i.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [itemId]
            );
            if (!itemRows.length) {
                console.log(`Item ${itemId} no encontrado`);
                await connection.rollback();
                connection.release();
                return res.status(404).json({ error: 'Item no encontrado' });
            }
            if (String(itemRows[0].estado || '').toLowerCase() !== 'pendiente') {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: 'Solo se pueden eliminar items pendientes (antes de enviar)' });
            }

            const [result] = await connection.query(
                `DELETE FROM pedido_items WHERE id = ? AND estado = 'pendiente'`,
                [itemId]
            );
            if ((result?.affectedRows || 0) === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: 'No se pudo eliminar el item' });
            }

            await syncMesaEstadoByItems(connection, itemRows[0].mesa_id);
            await connection.commit();
            connection.release();
            console.log(`Item ${itemId} eliminado exitosamente`);
            res.json({ message: 'Item eliminado' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al eliminar item:', error);
        res.status(500).json({ error: 'Error al eliminar item' });
    }
});

// PUT /mesas/items/:itemId/enviar - API: enviar item a cocina
router.put('/items/:itemId/enviar', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const [result] = await db.query(
            `UPDATE pedido_items
             SET estado = 'enviado', enviado_at = NOW()
             WHERE id = ? AND estado = 'pendiente'`,
            [itemId]
        );
        if (result.affectedRows === 0) return res.status(400).json({ error: 'Solo se pueden enviar items pendientes' });
        res.json({ message: 'Item enviado a cocina' });
    } catch (error) {
        console.error('Error al enviar item:', error);
        res.status(500).json({ error: 'Error al enviar item' });
    }
});

// PUT /mesas/items/:itemId/cancelar - API: cancelar item desde Mesa (mesero/admin)
// Reglas:
// - Permite cancelar items en estados operativos: pendiente, enviado, preparando, listo
// - Se marca como "rechazado" para que sea visible en Cocina (tab Rechazados)
// Relacionado con:
// - public/js/mesas.js (botón Cancelar en la mesa)
// - routes/cocina.js (GET /api/cocina/rechazados)
router.put('/items/:itemId/cancelar', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const rol = String(req.session?.user?.rol || '').toLowerCase();
        if (!['mesero', 'administrador'].includes(rol)) {
            return res.status(403).json({ error: 'No autorizado para cancelar items desde mesa' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [result] = await connection.query(
                `UPDATE pedido_items
                 SET estado = 'rechazado'
                 WHERE id = ?
                   AND estado IN ('pendiente','enviado','preparando','listo')`,
                [itemId]
            );
            if ((result?.affectedRows || 0) === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: 'No se pudo cancelar: estado no permitido o item no encontrado' });
            }

            const mesaId = await getMesaIdByItem(connection, itemId);
            if (mesaId) await syncMesaEstadoByItems(connection, mesaId);

            await connection.commit();
            connection.release();
            res.json({ message: 'Item cancelado' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al cancelar item desde mesa:', error);
        res.status(500).json({ error: 'Error al cancelar item' });
    }
});

// DELETE /mesas/pedidos/:pedidoId/items/rechazados - limpiar items rechazados/cancelados de un pedido
// Reglas:
// - Solo mesero/admin puede ejecutar limpieza desde la mesa
// - Borra items en estado final no facturable: rechazado/cancelado
// - Si el pedido queda sin items, lo marca como cancelado para que la mesa quede limpia
// Relacionado con:
// - public/js/mesas.js (botón "Limpiar rechazados")
// - views/mesas.ejs (controles del offcanvas)
router.delete('/pedidos/:pedidoId/items/rechazados', async (req, res) => {
    try {
        const pedidoId = req.params.pedidoId;
        const rol = String(req.session?.user?.rol || '').toLowerCase();
        if (!['mesero', 'administrador'].includes(rol)) {
            return res.status(403).json({ error: 'No autorizado para limpiar items rechazados' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [pedRows] = await connection.query(
                `SELECT id, mesa_id, estado
                 FROM pedidos
                 WHERE id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [pedidoId]
            );
            if (!pedRows.length) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }
            const pedido = pedRows[0];

            const [result] = await connection.query(
                `DELETE FROM pedido_items
                 WHERE pedido_id = ?
                   AND estado IN ('rechazado','cancelado')`,
                [pedidoId]
            );

            const [restantes] = await connection.query(
                `SELECT COUNT(*) AS cnt
                 FROM pedido_items
                 WHERE pedido_id = ?`,
                [pedidoId]
            );
            const quedanItems = Number(restantes?.[0]?.cnt || 0);

            if (quedanItems === 0 && !['cerrado', 'cancelado', 'rechazado'].includes(String(pedido.estado || '').toLowerCase())) {
                await connection.query(
                    `UPDATE pedidos
                     SET estado = 'cancelado', total = 0
                     WHERE id = ?`,
                    [pedidoId]
                );
            }

            await syncMesaEstadoByItems(connection, pedido.mesa_id);
            await connection.commit();
            connection.release();

            res.json({
                message: 'Items rechazados limpiados',
                eliminados: Number(result?.affectedRows || 0),
                pedido_cancelado: quedanItems === 0
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al limpiar items rechazados:', error);
        res.status(500).json({ error: 'Error al limpiar items rechazados' });
    }
});

// PUT /mesas/items/:itemId/estado - API: actualizar estado de item (preparando, listo, servido, cancelado)
router.put('/items/:itemId/estado', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const { estado } = req.body || {};
        // 'rechazado' se usa para visualizar cancelaciones en Cocina.
        // Relacionado con: routes/cocina.js (/api/cocina/rechazados)
        const permitidos = ['pendiente','enviado','preparando','listo','servido','cancelado','rechazado'];
        if (!permitidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

        // Restricción por rol:
        // - Mesero: SOLO puede marcar "servido" y SOLO si el item está en estado "listo"
        // Relacionado con: vista Cocina (pestaña Listos) y requisito del usuario
        const rol = String(req.session?.user?.rol || '').toLowerCase();
        if (rol === 'mesero') {
            if (estado !== 'servido') {
                return res.status(403).json({ error: 'No autorizado: el mesero solo puede marcar como entregado' });
            }
            const [resultServido] = await db.query(
                `UPDATE pedido_items SET estado = 'servido', servido_at = NOW() WHERE id = ? AND estado = 'listo'`,
                [itemId]
            );
            if ((resultServido?.affectedRows || 0) === 0) {
                return res.status(400).json({ error: 'Solo se puede marcar como entregado cuando el pedido está listo' });
            }
            const connection = await db.getConnection();
            try {
                const mesaId = await getMesaIdByItem(connection, itemId);
                if (mesaId) await syncMesaEstadoByItems(connection, mesaId);
            } finally {
                connection.release();
            }
            return res.json({ message: 'Estado actualizado' });
        }

        let timestampField = null;
        if (estado === 'preparando') timestampField = 'preparado_at';
        if (estado === 'listo') timestampField = 'listo_at';
        if (estado === 'servido') timestampField = 'servido_at';

        if (timestampField) {
            await db.query(
                `UPDATE pedido_items SET estado = ?, ${timestampField} = NOW() WHERE id = ?`,
                [estado, itemId]
            );
        } else {
            await db.query(
                `UPDATE pedido_items SET estado = ? WHERE id = ?`,
                [estado, itemId]
            );
        }

        const connection = await db.getConnection();
        try {
            const mesaId = await getMesaIdByItem(connection, itemId);
            if (mesaId) await syncMesaEstadoByItems(connection, mesaId);
        } finally {
            connection.release();
        }
        res.json({ message: 'Estado actualizado' });
    } catch (error) {
        console.error('Error al actualizar estado de item:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// POST /mesas/pedidos/:pedidoId/facturar - API: genera factura desde pedido y cierra mesa
router.post('/pedidos/:pedidoId/facturar', async (req, res) => {
    const pedidoId = req.params.pedidoId;
    const { cliente_id, forma_pago, pagos } = req.body || {};
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido para facturar' });
    // forma_pago se mantiene por compatibilidad, pero lo recomendado es enviar pagos[] (pago mixto)
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [pedidos] = await connection.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
            if (pedidos.length === 0) throw new Error('Pedido no encontrado');
            const pedido = pedidos[0];

            const [items] = await connection.query(
                // Excluir items cancelados o rechazados de la factura
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT * FROM pedido_items WHERE pedido_id = ? AND estado NOT IN ('cancelado','rechazado')`,
                [pedidoId]
            );
            if (items.length === 0) throw new Error('Pedido sin items');

            const total = items.reduce((acc, it) => acc + Number(it.subtotal || 0), 0);

            // ===== Pago mixto: validar pagos[] si se envía =====
            // Relacionado con: public/js/mesas.js (modal de pagos)
            const normalizarPagos = (arr) => {
                if (!Array.isArray(arr)) return [];
                return arr
                    .filter(p => p && typeof p === 'object')
                    .map(p => ({
                        metodo: String(p.metodo || '').toLowerCase().trim(),
                        monto: Number(p.monto || 0),
                        referencia: (p.referencia != null && String(p.referencia).trim() !== '') ? String(p.referencia).trim() : null
                    }))
                    .filter(p => ['efectivo', 'transferencia', 'tarjeta'].includes(p.metodo) && Number.isFinite(p.monto) && p.monto > 0);
            };
            const pagosNorm = normalizarPagos(pagos);
            const sumaPagos = pagosNorm.reduce((acc, p) => acc + Number(p.monto || 0), 0);
            const almostEqualMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

            let formaPagoDB = String(forma_pago || 'efectivo').toLowerCase();
            if (pagosNorm.length > 0) {
                if (!almostEqualMoney(sumaPagos, total)) {
                    throw new Error('La suma de pagos no coincide con el total');
                }
                formaPagoDB = (pagosNorm.length === 1) ? pagosNorm[0].metodo : 'mixto';
            } else {
                // Compatibilidad: si no envían pagos, usamos forma_pago (y creamos 1 registro en factura_pagos)
                if (!['efectivo', 'transferencia', 'tarjeta', 'mixto'].includes(formaPagoDB)) formaPagoDB = 'efectivo';
            }

            const [facturaInsert] = await connection.query(
                `INSERT INTO facturas (cliente_id, total, forma_pago) VALUES (?, ?, ?)`,
                [cliente_id, total, formaPagoDB]
            );
            const facturaId = facturaInsert.insertId;

            const detallesValues = items.map(i => [
                facturaId,
                i.producto_id,
                i.cantidad,
                i.precio_unitario,
                i.unidad_medida,
                i.subtotal
            ]);
            await connection.query(
                `INSERT INTO detalle_factura (factura_id, producto_id, cantidad, precio_unitario, unidad_medida, subtotal) VALUES ?`,
                [detallesValues]
            );

            // Guardar pagos en factura_pagos (si existe la tabla)
            try {
                if (pagosNorm.length > 0) {
                    const pagosValues = pagosNorm.map(p => ([facturaId, p.metodo, p.monto, p.referencia]));
                    await connection.query(
                        'INSERT INTO factura_pagos (factura_id, metodo, monto, referencia) VALUES ?',
                        [pagosValues]
                    );
                } else {
                    await connection.query(
                        'INSERT INTO factura_pagos (factura_id, metodo, monto, referencia) VALUES (?, ?, ?, ?)',
                        [facturaId, (formaPagoDB === 'mixto' ? 'efectivo' : formaPagoDB), total, null]
                    );
                }
            } catch (_) {
                // Si la tabla no existe, no rompemos la facturación
            }

            await connection.query(`UPDATE pedidos SET estado = 'cerrado', total = ? WHERE id = ?`, [total, pedidoId]);
            await connection.query(`UPDATE mesas SET estado = 'libre' WHERE id = ?`, [pedido.mesa_id]);

            await connection.commit();
            connection.release();
            res.status(201).json({ factura_id: facturaId });
        } catch (error) {
            await connection.rollback();
            connection.release();
            console.error('Error en facturación desde pedido:', error);
            res.status(500).json({ error: 'Error al facturar pedido' });
        }
    } catch (error) {
        console.error('Error al preparar facturación:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT /mesas/pedidos/:pedidoId/mover - Mover pedido a otra mesa (si está libre)
router.put('/pedidos/:pedidoId/mover', async (req, res) => {
    const pedidoId = req.params.pedidoId;
    const { mesa_destino_id } = req.body || {};
    if (!mesa_destino_id) return res.status(400).json({ error: 'mesa_destino_id requerido' });
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Lock pedido
            const [pedidos] = await connection.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
            if (pedidos.length === 0) throw new Error('Pedido no encontrado');
            const pedido = pedidos[0];

            // Validar que el destino esté libre: sin pedidos abiertos
            const [abiertosDestino] = await connection.query(
                // 'rechazado' se considera finalizado (no pedido activo)
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT COUNT(*) as cnt FROM pedidos WHERE mesa_id = ? AND estado NOT IN ('cerrado','cancelado','rechazado')`,
                [mesa_destino_id]
            );
            if ((abiertosDestino[0]?.cnt || 0) > 0) {
                throw new Error('La mesa destino tiene un pedido activo');
            }

            // Actualizar estados de mesas (origen puede quedar ocupada si tuviera otros pedidos, pero por defecto quedará libre)
            await connection.query('UPDATE pedidos SET mesa_id = ? WHERE id = ?', [mesa_destino_id, pedidoId]);

            // Poner libre la mesa origen si no le quedan pedidos abiertos
            const [restantesOrigen] = await connection.query(
                // 'rechazado' se considera finalizado (no pedido activo)
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT COUNT(*) as cnt FROM pedidos WHERE mesa_id = ? AND estado NOT IN ('cerrado','cancelado','rechazado')`,
                [pedido.mesa_id]
            );
            if ((restantesOrigen[0]?.cnt || 0) === 0) {
                await connection.query('UPDATE mesas SET estado = "libre" WHERE id = ?', [pedido.mesa_id]);
            }

            // Poner ocupada la mesa destino
            await connection.query('UPDATE mesas SET estado = "ocupada" WHERE id = ?', [mesa_destino_id]);

            await connection.commit();
            connection.release();
            res.json({ message: 'Pedido movido', mesa_origen_id: pedido.mesa_id, mesa_destino_id });
        } catch (error) {
            await connection.rollback();
            connection.release();
            console.error('Error al mover pedido:', error);
            res.status(400).json({ error: error.message || 'Error al mover pedido' });
        }
    } catch (error) {
        console.error('Error interno al mover pedido:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT /mesas/:mesaId/liberar - Libera mesa si no tiene items en pedidos abiertos
router.put('/:mesaId/liberar', async (req, res) => {
    const mesaId = req.params.mesaId;
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Revisar pedidos abiertos en esa mesa
            const [abiertos] = await connection.query(
                // 'rechazado' se considera finalizado (no pedido activo)
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT p.id FROM pedidos p WHERE p.mesa_id = ? AND p.estado NOT IN ('cerrado','cancelado','rechazado') FOR UPDATE`,
                [mesaId]
            );

            if (abiertos.length > 0) {
                // Verificar que no tengan items distintos de cancelado
                const ids = abiertos.map(p => p.id);
                const [items] = await connection.query(
                    // Consideramos "rechazado" igual que "cancelado" (no es item activo)
                    // Relacionado con: estado "rechazado" (database.sql)
                    `SELECT COUNT(*) as cnt FROM pedido_items WHERE pedido_id IN (?) AND estado NOT IN ('cancelado','rechazado')`,
                    [ids]
                );
                if ((items[0]?.cnt || 0) > 0) {
                    throw new Error('La mesa tiene items activos, no se puede liberar');
                }
                // Si no hay items activos, marcamos esos pedidos como RECHAZADOS (nuevo estado)
                // y actualizamos items cancelados a rechazados para poder visualizarlos en Cocina.
                // Relacionado con:
                // - routes/cocina.js (GET /api/cocina/rechazados)
                // - views/cocina.ejs (pestaña Rechazados)
                await connection.query(
                    `UPDATE pedido_items SET estado = 'rechazado' WHERE pedido_id IN (?) AND estado = 'cancelado'`,
                    [ids]
                );
                await connection.query(`UPDATE pedidos SET estado = 'rechazado' WHERE id IN (?)`, [ids]);
            }

            await connection.query(`UPDATE mesas SET estado = 'libre' WHERE id = ?`, [mesaId]);
            await connection.commit();
            connection.release();
            res.json({ message: 'Mesa liberada' });
        } catch (error) {
            await connection.rollback();
            connection.release();
            console.error('Error al liberar mesa:', error);
            res.status(400).json({ error: error.message || 'Error al liberar mesa' });
        }
    } catch (error) {
        console.error('Error interno al liberar mesa:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;


