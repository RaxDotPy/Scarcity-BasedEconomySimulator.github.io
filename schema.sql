-- ============================================================
-- SIMULADOR DE ECONOMÍA BASADA EN ESCASEZ
-- Schema SQL con soporte para transacciones concurrentes
-- ============================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- TABLA: rarity_tiers
-- Define los niveles de rareza y sus probabilidades base
-- ============================================================
CREATE TABLE rarity_tiers (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(30) NOT NULL UNIQUE,  -- 'Common', 'Uncommon', etc.
    code        CHAR(2)     NOT NULL UNIQUE,  -- 'CM', 'UC', 'RR', 'EP', 'LG'
    drop_rate   NUMERIC(8,6) NOT NULL CHECK (drop_rate > 0 AND drop_rate <= 1),
    color_hex   CHAR(7)     NOT NULL,
    base_price  NUMERIC(14,4) NOT NULL CHECK (base_price > 0),
    max_supply  INTEGER,                      -- NULL = ilimitado
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO rarity_tiers (name, code, drop_rate, color_hex, base_price, max_supply) VALUES
    ('Common',     'CM', 0.600000, '#9CA3AF',  10.00,     NULL),
    ('Uncommon',   'UC', 0.250000, '#22C55E',  50.00,     NULL),
    ('Rare',       'RR', 0.100000, '#3B82F6',  250.00,    NULL),
    ('Epic',       'EP', 0.040000, '#A855F7',  1500.00,   10000),
    ('Legendary',  'LG', 0.009000, '#F59E0B',  10000.00,  1000),
    ('Mythic',     'MK', 0.001000, '#EF4444',  100000.00, 100);

-- ============================================================
-- TABLA: items
-- Catálogo de objetos en el ecosistema
-- ============================================================
CREATE TABLE items (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    rarity_id       INTEGER     NOT NULL REFERENCES rarity_tiers(id),
    total_minted    INTEGER     NOT NULL DEFAULT 0,
    is_tradeable    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    metadata        JSONB       DEFAULT '{}'
);

CREATE INDEX idx_items_rarity ON items(rarity_id);
CREATE INDEX idx_items_tradeable ON items(is_tradeable) WHERE is_tradeable = TRUE;

-- ============================================================
-- TABLA: item_instances
-- Cada instancia individual de un objeto (con dueño)
-- ============================================================
CREATE TABLE item_instances (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id         UUID        NOT NULL REFERENCES items(id),
    owner_id        UUID        NOT NULL,    -- FK a tabla users (externa)
    serial_number   INTEGER     NOT NULL,    -- #1, #2, ... de N totales
    is_listed       BOOLEAN     NOT NULL DEFAULT FALSE,
    listed_price    NUMERIC(14,4),
    listed_at       TIMESTAMPTZ,
    acquired_at     TIMESTAMPTZ DEFAULT NOW(),
    acquired_price  NUMERIC(14,4),
    UNIQUE(item_id, serial_number)
);

CREATE INDEX idx_instances_owner   ON item_instances(owner_id);
CREATE INDEX idx_instances_listed  ON item_instances(is_listed) WHERE is_listed = TRUE;
CREATE INDEX idx_instances_item    ON item_instances(item_id);

-- ============================================================
-- TABLA: market_prices
-- Historial OHLCV por intervalo (para las velas)
-- ============================================================
CREATE TABLE market_prices (
    id          BIGSERIAL   PRIMARY KEY,
    item_id     UUID        NOT NULL REFERENCES items(id),
    interval    VARCHAR(10) NOT NULL DEFAULT '1m',  -- 1m, 5m, 1h, 1d
    ts          TIMESTAMPTZ NOT NULL,               -- inicio del intervalo
    open_price  NUMERIC(14,4) NOT NULL,
    high_price  NUMERIC(14,4) NOT NULL,
    low_price   NUMERIC(14,4) NOT NULL,
    close_price NUMERIC(14,4) NOT NULL,
    volume      NUMERIC(18,4) NOT NULL DEFAULT 0,
    trade_count INTEGER     NOT NULL DEFAULT 0,
    UNIQUE(item_id, interval, ts)
);

CREATE INDEX idx_prices_item_ts  ON market_prices(item_id, ts DESC);
CREATE INDEX idx_prices_interval ON market_prices(interval, ts DESC);

-- ============================================================
-- TABLA: orders
-- Órdenes de compra/venta en el libro de órdenes
-- ============================================================
CREATE TYPE order_side   AS ENUM ('buy', 'sell');
CREATE TYPE order_status AS ENUM ('open', 'partial', 'filled', 'cancelled', 'expired');
CREATE TYPE order_type   AS ENUM ('market', 'limit');

CREATE TABLE orders (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id         UUID        NOT NULL REFERENCES items(id),
    instance_id     UUID        REFERENCES item_instances(id),  -- para sell orders
    user_id         UUID        NOT NULL,
    side            order_side  NOT NULL,
    order_type      order_type  NOT NULL DEFAULT 'limit',
    status          order_status NOT NULL DEFAULT 'open',
    price           NUMERIC(14,4),           -- NULL para market orders
    quantity        INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0),
    filled_qty      INTEGER     NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_item_side  ON orders(item_id, side, status, price);
CREATE INDEX idx_orders_user       ON orders(user_id, status);
CREATE INDEX idx_orders_open       ON orders(item_id, side, price) 
    WHERE status IN ('open', 'partial');

-- ============================================================
-- TABLA: transactions
-- Registro inmutable de todas las transacciones
-- ============================================================
CREATE TABLE transactions (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id         UUID        NOT NULL REFERENCES items(id),
    instance_id     UUID        NOT NULL REFERENCES item_instances(id),
    buy_order_id    UUID        NOT NULL REFERENCES orders(id),
    sell_order_id   UUID        NOT NULL REFERENCES orders(id),
    buyer_id        UUID        NOT NULL,
    seller_id       UUID        NOT NULL,
    price           NUMERIC(14,4) NOT NULL CHECK (price > 0),
    quantity        INTEGER     NOT NULL DEFAULT 1,
    fee_amount      NUMERIC(14,4) NOT NULL DEFAULT 0,
    executed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tx_item     ON transactions(item_id, executed_at DESC);
CREATE INDEX idx_tx_buyer    ON transactions(buyer_id, executed_at DESC);
CREATE INDEX idx_tx_seller   ON transactions(seller_id, executed_at DESC);
CREATE INDEX idx_tx_time     ON transactions(executed_at DESC);

-- ============================================================
-- TABLA: market_stats
-- Estadísticas globales del mercado en tiempo real
-- ============================================================
CREATE TABLE market_stats (
    item_id         UUID        PRIMARY KEY REFERENCES items(id),
    last_price      NUMERIC(14,4),
    price_24h_ago   NUMERIC(14,4),
    high_24h        NUMERIC(14,4),
    low_24h         NUMERIC(14,4),
    volume_24h      NUMERIC(18,4) DEFAULT 0,
    trades_24h      INTEGER DEFAULT 0,
    active_listings INTEGER DEFAULT 0,
    inflation_index NUMERIC(8,4) DEFAULT 1.0000,  -- 1.0 = precio base
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: users (simplificada para el simulador)
-- ============================================================
CREATE TABLE users (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    username    VARCHAR(50) NOT NULL UNIQUE,
    balance     NUMERIC(18,4) NOT NULL DEFAULT 10000.0000 CHECK (balance >= 0),
    is_bot      BOOLEAN     NOT NULL DEFAULT FALSE,
    activity_score NUMERIC(8,4) DEFAULT 1.0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Ahora añadimos las FK que faltaban (evitar dependencia circular)
ALTER TABLE item_instances ADD CONSTRAINT fk_instance_owner 
    FOREIGN KEY (owner_id) REFERENCES users(id);
ALTER TABLE orders ADD CONSTRAINT fk_order_user 
    FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE transactions ADD CONSTRAINT fk_tx_buyer 
    FOREIGN KEY (buyer_id) REFERENCES users(id);
ALTER TABLE transactions ADD CONSTRAINT fk_tx_seller 
    FOREIGN KEY (seller_id) REFERENCES users(id);

-- ============================================================
-- FUNCIÓN: match_orders()
-- Motor de matching con bloqueo pesimista para concurrencia
-- ============================================================
CREATE OR REPLACE FUNCTION match_orders(p_sell_order_id UUID)
RETURNS TABLE(matched BOOLEAN, tx_id UUID, match_price NUMERIC) 
LANGUAGE plpgsql AS $$
DECLARE
    v_sell      orders%ROWTYPE;
    v_buy       orders%ROWTYPE;
    v_instance  item_instances%ROWTYPE;
    v_tx_id     UUID;
    v_fee       NUMERIC(14,4);
    v_fee_rate  CONSTANT NUMERIC := 0.025;  -- 2.5% fee
BEGIN
    -- Bloquear la sell order para evitar doble match
    SELECT * INTO v_sell FROM orders
        WHERE id = p_sell_order_id AND status IN ('open','partial')
        FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::NUMERIC;
        RETURN;
    END IF;

    -- Bloquear la instancia del item
    SELECT * INTO v_instance FROM item_instances
        WHERE id = v_sell.instance_id
        FOR UPDATE;

    -- Buscar la mejor buy order coincidente (mayor precio primero, FIFO)
    SELECT * INTO v_buy FROM orders
        WHERE item_id = v_sell.item_id
          AND side = 'buy'
          AND status IN ('open','partial')
          AND (price IS NULL OR price >= COALESCE(v_sell.price, 0))
          AND user_id <> v_sell.user_id
        ORDER BY 
            CASE WHEN order_type = 'market' THEN 0 ELSE 1 END,
            price DESC,
            created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::NUMERIC;
        RETURN;
    END IF;

    -- Precio de ejecución: precio de la sell order (maker)
    v_fee := COALESCE(v_sell.price, v_buy.price) * v_fee_rate;

    -- Crear transacción
    INSERT INTO transactions (
        item_id, instance_id, buy_order_id, sell_order_id,
        buyer_id, seller_id, price, fee_amount
    ) VALUES (
        v_sell.item_id, v_sell.instance_id, v_buy.id, v_sell.id,
        v_buy.user_id, v_sell.user_id,
        COALESCE(v_sell.price, v_buy.price),
        v_fee
    ) RETURNING id INTO v_tx_id;

    -- Transferir ownership de la instancia
    UPDATE item_instances SET
        owner_id = v_buy.user_id,
        is_listed = FALSE,
        listed_price = NULL,
        listed_at = NULL,
        acquired_at = NOW(),
        acquired_price = COALESCE(v_sell.price, v_buy.price)
    WHERE id = v_sell.instance_id;

    -- Actualizar balances
    UPDATE users SET balance = balance - COALESCE(v_sell.price, v_buy.price) - v_fee
        WHERE id = v_buy.user_id;
    UPDATE users SET balance = balance + COALESCE(v_sell.price, v_buy.price) - v_fee
        WHERE id = v_sell.user_id;

    -- Marcar órdenes como filled
    UPDATE orders SET status = 'filled', filled_qty = quantity, updated_at = NOW()
        WHERE id IN (v_sell.id, v_buy.id);

    -- Actualizar stats de mercado
    INSERT INTO market_stats (item_id, last_price, high_24h, low_24h, volume_24h, trades_24h)
    VALUES (v_sell.item_id, COALESCE(v_sell.price, v_buy.price),
            COALESCE(v_sell.price, v_buy.price), COALESCE(v_sell.price, v_buy.price),
            COALESCE(v_sell.price, v_buy.price), 1)
    ON CONFLICT (item_id) DO UPDATE SET
        last_price   = EXCLUDED.last_price,
        high_24h     = GREATEST(market_stats.high_24h, EXCLUDED.last_price),
        low_24h      = LEAST(market_stats.low_24h, EXCLUDED.last_price),
        volume_24h   = market_stats.volume_24h + EXCLUDED.last_price,
        trades_24h   = market_stats.trades_24h + 1,
        updated_at   = NOW();

    RETURN QUERY SELECT TRUE, v_tx_id, COALESCE(v_sell.price, v_buy.price);
END;
$$;

-- ============================================================
-- VISTA: order_book
-- Vista del libro de órdenes actual
-- ============================================================
CREATE OR REPLACE VIEW order_book AS
SELECT 
    o.item_id,
    i.name AS item_name,
    rt.name AS rarity,
    rt.color_hex,
    o.side,
    o.price,
    COUNT(*) AS order_count,
    SUM(o.quantity - o.filled_qty) AS total_quantity
FROM orders o
JOIN items i ON i.id = o.item_id
JOIN rarity_tiers rt ON rt.id = i.rarity_id
WHERE o.status IN ('open', 'partial')
GROUP BY o.item_id, i.name, rt.name, rt.color_hex, o.side, o.price
ORDER BY o.item_id, o.side, o.price DESC;

-- ============================================================
-- FIN DEL SCHEMA
-- ============================================================
