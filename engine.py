"""
=============================================================
SIMULADOR DE ECONOMÍA BASADA EN ESCASEZ
Engine Python: Drop Rates, Inflación y Market Simulation
=============================================================
 
Módulos:
  - DropEngine      : Probabilidades de aparición por rareza
  - InflationEngine : Algoritmo dinámico de inflación de precios
  - MarketSimulator : Simulador de actividad de mercado (bots + eventos)
  - PriceAggregator : Genera velas OHLCV para el frontend
 
Dependencias: pip install numpy scipy psycopg2-binary faker asyncio
"""
 
import random
import math
import time
import json
import asyncio
import numpy as np
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime, timedelta
from collections import deque
 
 
# ─────────────────────────────────────────────────────────────────────────────
# DATACLASSES
# ─────────────────────────────────────────────────────────────────────────────
 
@dataclass
class RarityTier:
    code: str
    name: str
    drop_rate: float       # Probabilidad base (0–1)
    base_price: float
    color_hex: str
    max_supply: Optional[int] = None
    current_supply: int = 0
 
    @property
    def is_supply_capped(self) -> bool:
        return self.max_supply is not None
 
    @property
    def supply_ratio(self) -> float:
        """Qué tan cerca está del límite de supply (0=vacío, 1=lleno)."""
        if not self.is_supply_capped:
            return 0.0
        return self.current_supply / self.max_supply
 
 
@dataclass
class MarketTick:
    item_id: str
    price: float
    volume: float
    timestamp: float = field(default_factory=time.time)
 
 
@dataclass
class Candle:
    ts: float
    open: float
    high: float
    low: float
    close: float
    volume: float
    trades: int
 
 
# ─────────────────────────────────────────────────────────────────────────────
# DROP ENGINE
# ─────────────────────────────────────────────────────────────────────────────
 
class DropEngine:
    """
    Motor de drop rates con múltiples mecanismos:
      1. Pity system (garantía de rareza alta después de N intentos sin ella)
      2. Supply pressure (si un item escasea, su drop rate baja)
      3. Boost events (eventos temporales que alteran probabilidades)
    """
 
    TIERS = [
        RarityTier('CM', 'Common',    0.600, 10.0,     '#9CA3AF'),
        RarityTier('UC', 'Uncommon',  0.250, 50.0,     '#22C55E'),
        RarityTier('RR', 'Rare',      0.100, 250.0,    '#3B82F6'),
        RarityTier('EP', 'Epic',      0.040, 1500.0,   '#A855F7', max_supply=10_000),
        RarityTier('LG', 'Legendary', 0.009, 10_000.0, '#F59E0B', max_supply=1_000),
        RarityTier('MK', 'Mythic',    0.001, 100_000.0,'#EF4444', max_supply=100),
    ]
 
    PITY_THRESHOLDS = {
        'RR': 40,   # Después de 40 drops sin Rare, garantía
        'EP': 80,   # Después de 80 drops sin Epic
        'LG': 200,  # Después de 200 drops sin Legendary
        'MK': 500,  # Después de 500 drops sin Mythic
    }
 
    def __init__(self):
        self._pity_counters: dict[str, int] = {t: 0 for t in self.PITY_THRESHOLDS}
        self._boosts: dict[str, float] = {}  # tier_code -> multiplicador temporal
        self._rng = np.random.default_rng()
 
    def set_boost(self, tier_code: str, multiplier: float, duration_s: float):
        """Activa un boost temporal de drop rate para un tier."""
        self._boosts[tier_code] = {
            'multiplier': multiplier,
            'expires_at': time.time() + duration_s
        }
        print(f"[DropEngine] Boost x{multiplier} en {tier_code} por {duration_s}s")
 
    def _effective_rates(self) -> list[float]:
        """Calcula las tasas efectivas incluyendo boosts activos y pity."""
        now = time.time()
        rates = []
        for tier in self.TIERS:
            r = tier.drop_rate
 
            # Aplicar boost si está activo
            boost = self._boosts.get(tier.code)
            if boost and boost['expires_at'] > now:
                r = min(1.0, r * boost['multiplier'])
            elif boost and boost['expires_at'] <= now:
                del self._boosts[tier.code]
 
            # Supply pressure: si el tier tiene cap y está al 80%+, bajar drop rate
            if tier.is_supply_capped and tier.supply_ratio >= 0.8:
                pressure = 1.0 - (tier.supply_ratio - 0.8) * 5  # 0.8→1.0 = 100%→0%
                r = r * max(0.0, pressure)
 
            rates.append(r)
 
        # Normalizar para que sumen 1
        total = sum(rates)
        return [r / total for r in rates]
 
    def roll(self) -> RarityTier:
        """
        Realiza un drop y retorna el tier obtenido.
        Incluye pity system automático.
        """
        # Verificar pity (de mayor a menor rareza)
        for tier_code, threshold in sorted(
            self.PITY_THRESHOLDS.items(), 
            key=lambda x: -self.TIERS[[t.code for t in self.TIERS].index(x[0])].drop_rate
        ):
            if self._pity_counters.get(tier_code, 0) >= threshold:
                tier = next(t for t in self.TIERS if t.code == tier_code)
                self._reset_pity_below(tier_code)
                print(f"[DropEngine] ¡PITY activado! Garantía de {tier.name}")
                return tier
 
        # Roll normal con distribución ponderada
        rates = self._effective_rates()
        idx = self._rng.choice(len(self.TIERS), p=rates)
        result = self.TIERS[idx]
 
        # Actualizar contadores de pity
        for code in self.PITY_THRESHOLDS:
            if code != result.code:
                self._pity_counters[code] = self._pity_counters.get(code, 0) + 1
            else:
                self._pity_counters[code] = 0
 
        # Incrementar supply si hay cap
        result.current_supply += 1
        return result
 
    def _reset_pity_below(self, tier_code: str):
        """Resetea contadores de pity para tiers de rareza igual o menor."""
        tier_codes = [t.code for t in self.TIERS]
        idx = tier_codes.index(tier_code)
        for code in tier_codes[idx:]:
            self._pity_counters[code] = 0
 
    def batch_roll(self, n: int) -> dict[str, int]:
        """Realiza N drops y retorna conteo por tier."""
        counts = {t.code: 0 for t in self.TIERS}
        for _ in range(n):
            tier = self.roll()
            counts[tier.code] += 1
        return counts
 
    def simulate_distribution(self, n: int = 10_000) -> None:
        """Imprime la distribución empírica de N drops."""
        print(f"\n[DropEngine] Simulando {n:,} drops...")
        counts = self.batch_roll(n)
        print(f"{'Tier':<12} {'Expected':>10} {'Actual':>10} {'Diff':>8}")
        print("─" * 44)
        for tier in self.TIERS:
            expected = tier.drop_rate * n
            actual = counts[tier.code]
            diff = actual - expected
            print(f"{tier.name:<12} {expected:>10.1f} {actual:>10d} {diff:>+8.1f}")
 
 
# ─────────────────────────────────────────────────────────────────────────────
# INFLATION ENGINE
# ─────────────────────────────────────────────────────────────────────────────
 
class InflationEngine:
    """
    Algoritmo de inflación dinámica basado en:
      1. Volumen de transacciones (más tx = más presión alcista)
      2. Usuarios activos (más usuarios = más demanda)
      3. Supply disponible en el mercado (menos oferta = precio sube)
      4. Velocidad de cambio de precio (momentum)
      5. Mean reversion hacia el precio base
    """
 
    def __init__(self, base_price: float, rarity_tier: RarityTier):
        self.base_price = base_price
        self.tier = rarity_tier
        self.current_price = base_price
        self._price_history: deque[float] = deque(maxlen=100)
        self._tx_history: deque[float] = deque(maxlen=60)   # últimos 60 ticks
        self._price_history.append(base_price)
 
        # Parámetros del modelo
        self.MEAN_REVERSION_SPEED = 0.02  # Qué tan rápido vuelve al precio base
        self.VOLUME_SENSITIVITY   = 0.001  # Impacto del volumen en el precio
        self.USER_SENSITIVITY     = 0.005  # Impacto de usuarios activos
        self.SCARCITY_MULTIPLIER  = 2.0    # Amplificador cuando el supply es bajo
        self.VOLATILITY_BASE      = 0.015  # Volatilidad base (ruido de mercado)
 
        # Ajustar volatilidad por rareza (items más raros = más volátiles)
        rarity_volatility = {
            'CM': 1.0, 'UC': 1.2, 'RR': 1.5,
            'EP': 2.0, 'LG': 3.0, 'MK': 5.0
        }
        self.volatility = self.VOLATILITY_BASE * rarity_volatility.get(rarity_tier.code, 1.0)
 
    def calculate_new_price(
        self,
        tx_volume: float,
        active_users: int,
        listed_supply: int,
        total_supply: int
    ) -> float:
        """
        Calcula el nuevo precio usando el modelo de inflación.
        
        Args:
            tx_volume:    Volumen de transacciones en el último tick
            active_users: Número de usuarios activos en la sesión
            listed_supply: Cantidad de ítems en venta ahora mismo
            total_supply: Cantidad total mintada del ítem
        
        Returns:
            Nuevo precio calculado
        """
        P = self.current_price
        P0 = self.base_price
 
        # ── Factor 1: Mean reversion ──────────────────────────────────────────
        # El precio tiende a volver al precio base (eficiente a largo plazo)
        mean_reversion = self.MEAN_REVERSION_SPEED * (P0 - P) / P0
 
        # ── Factor 2: Presión de volumen ──────────────────────────────────────
        # Más transacciones = mayor demanda = precio sube
        self._tx_history.append(tx_volume)
        avg_volume = sum(self._tx_history) / len(self._tx_history)
        volume_pressure = self.VOLUME_SENSITIVITY * math.log1p(tx_volume / (avg_volume + 1))
 
        # ── Factor 3: Presión de usuarios activos ─────────────────────────────
        # Escalar usuarios (normalizado a 100 como baseline)
        user_pressure = self.USER_SENSITIVITY * math.log1p(active_users / 100)
 
        # ── Factor 4: Escasez de supply ───────────────────────────────────────
        # Si hay poco supply listado vs demanda (usuarios), precio sube fuerte
        supply_ratio = listed_supply / max(1, total_supply)
        demand_ratio = active_users / max(1, listed_supply * 10)
        scarcity = self.SCARCITY_MULTIPLIER * (1 - supply_ratio) * math.log1p(demand_ratio)
 
        # Para ítems con supply cap, la escasez se amplifica más
        if self.tier.is_supply_capped:
            cap_pressure = self.tier.supply_ratio ** 2  # Crece exponencial
            scarcity *= (1 + cap_pressure * 3)
 
        # ── Factor 5: Momentum (tendencia reciente) ───────────────────────────
        momentum = 0.0
        if len(self._price_history) >= 5:
            recent = list(self._price_history)[-5:]
            returns = [(recent[i] - recent[i-1]) / recent[i-1] for i in range(1, len(recent))]
            momentum = sum(returns) / len(returns) * 0.3  # 30% de momentum carry
 
        # ── Factor 6: Ruido de mercado (volatilidad estocástica) ──────────────
        # Usando Geometric Brownian Motion simplificado
        noise = np.random.normal(0, self.volatility)
 
        # ── Combinar todos los factores ───────────────────────────────────────
        total_drift = mean_reversion + volume_pressure + user_pressure + scarcity + momentum
        
        # Aplicar cambio de precio (GBM: P_new = P * e^(drift + noise))
        log_return = total_drift + noise
        
        # Clamp para evitar crashes o rallies extremos (circuit breaker)
        max_change = 0.15  # Máximo 15% de cambio por tick
        log_return = max(-max_change, min(max_change, log_return))
 
        new_price = P * math.exp(log_return)
 
        # Floor: el precio no puede bajar de 1% del precio base
        new_price = max(P0 * 0.01, new_price)
 
        self.current_price = new_price
        self._price_history.append(new_price)
        return round(new_price, 4)
 
    @property
    def price_change_24h(self) -> float:
        """Retorna el % de cambio desde el precio hace 24h (simulado)."""
        if len(self._price_history) < 2:
            return 0.0
        oldest = self._price_history[0]
        return (self.current_price - oldest) / oldest * 100
 
    @property
    def inflation_index(self) -> float:
        """Índice de inflación: precio actual / precio base."""
        return self.current_price / self.base_price
 
 
# ─────────────────────────────────────────────────────────────────────────────
# PRICE AGGREGATOR (Generador de Velas OHLCV)
# ─────────────────────────────────────────────────────────────────────────────
 
class PriceAggregator:
    """
    Agrega ticks de precios en velas OHLCV para múltiples intervalos.
    """
 
    def __init__(self, intervals_seconds: list[int] = [60, 300, 3600]):
        self.intervals = intervals_seconds
        self._ticks: deque[MarketTick] = deque(maxlen=10_000)
        self._candles: dict[int, list[Candle]] = {i: [] for i in intervals_seconds}
 
    def add_tick(self, tick: MarketTick):
        """Añade un tick de precio al aggregator."""
        self._ticks.append(tick)
 
    def get_candles(self, item_id: str, interval_s: int, n: int = 50) -> list[dict]:
        """
        Genera las últimas N velas para el item e intervalo dado.
        Si no hay suficientes ticks, simula historia sintética.
        """
        ticks = [t for t in self._ticks if t.item_id == item_id]
        
        if not ticks:
            return self._generate_synthetic_candles(n, interval_s)
 
        candles = []
        if ticks:
            # Agrupar ticks por intervalo
            start_ts = ticks[0].timestamp
            current_bucket = int(start_ts / interval_s) * interval_s
 
            bucket_ticks = []
            for tick in ticks:
                bucket = int(tick.timestamp / interval_s) * interval_s
                if bucket == current_bucket:
                    bucket_ticks.append(tick)
                else:
                    if bucket_ticks:
                        candles.append(self._ticks_to_candle(bucket_ticks, current_bucket))
                    bucket_ticks = [tick]
                    current_bucket = bucket
 
            if bucket_ticks:
                candles.append(self._ticks_to_candle(bucket_ticks, current_bucket))
 
        return [self._candle_to_dict(c) for c in candles[-n:]]
 
    def _ticks_to_candle(self, ticks: list[MarketTick], ts: float) -> Candle:
        prices = [t.price for t in ticks]
        return Candle(
            ts=ts,
            open=prices[0],
            high=max(prices),
            low=min(prices),
            close=prices[-1],
            volume=sum(t.volume for t in ticks),
            trades=len(ticks)
        )
 
    def _candle_to_dict(self, c: Candle) -> dict:
        return {
            'time': int(c.ts),
            'open': round(c.open, 4),
            'high': round(c.high, 4),
            'low': round(c.low, 4),
            'close': round(c.close, 4),
            'volume': round(c.volume, 4),
            'trades': c.trades
        }
 
    def _generate_synthetic_candles(self, n: int, interval_s: int, 
                                     base_price: float = 1000.0) -> list[dict]:
        """Genera velas sintéticas con GBM para inicializar el chart."""
        candles = []
        price = base_price
        now = time.time()
        start = now - n * interval_s
 
        for i in range(n):
            ts = start + i * interval_s
            volatility = 0.02
            drift = np.random.normal(0, volatility)
            open_p = price
            n_ticks = random.randint(3, 20)
            prices = [open_p]
            for _ in range(n_ticks - 1):
                prices.append(prices[-1] * math.exp(np.random.normal(0, volatility / 3)))
            
            high_p = max(prices)
            low_p = min(prices)
            close_p = prices[-1]
            volume = random.uniform(open_p * 0.5, open_p * 5)
 
            candles.append({
                'time': int(ts),
                'open': round(open_p, 4),
                'high': round(high_p, 4),
                'low': round(low_p, 4),
                'close': round(close_p, 4),
                'volume': round(volume, 4),
                'trades': n_ticks
            })
            price = close_p
 
        return candles
 
 
# ─────────────────────────────────────────────────────────────────────────────
# MARKET SIMULATOR (Bots + Eventos de Mercado)
# ─────────────────────────────────────────────────────────────────────────────
 
class MarketSimulator:
    """
    Simula la actividad del mercado con bots de diferentes estrategias
    y genera eventos aleatorios que afectan los precios.
    """
 
    MARKET_EVENTS = [
        {'name': 'Flash Sale',       'duration': 30,  'effect': 'volume_spike',  'magnitude': 3.0},
        {'name': 'Whale Buy',        'duration': 5,   'effect': 'price_spike',   'magnitude': 0.15},
        {'name': 'Mass Listing',     'duration': 60,  'effect': 'supply_flood',  'magnitude': 5.0},
        {'name': 'Rarity Boost',     'duration': 120, 'effect': 'drop_boost',    'magnitude': 2.0},
        {'name': 'Market Panic',     'duration': 45,  'effect': 'price_crash',   'magnitude': -0.20},
        {'name': 'FOMO Rally',       'duration': 90,  'effect': 'user_surge',    'magnitude': 4.0},
        {'name': 'Supply Burn',      'duration': 1,   'effect': 'supply_reduce', 'magnitude': 0.1},
    ]
 
    def __init__(self):
        self.items: list[dict] = []
        self.engines: dict[str, InflationEngine] = {}
        self.drop_engine = DropEngine()
        self.aggregator = PriceAggregator()
        self.active_events: list[dict] = []
        self.tick_count = 0
        self._active_users = 150
        self._is_running = False
 
    def register_item(self, item_id: str, name: str, tier: RarityTier):
        """Registra un ítem para ser simulado."""
        engine = InflationEngine(tier.base_price, tier)
        self.engines[item_id] = engine
        self.items.append({
            'id': item_id,
            'name': name,
            'tier': tier,
            'listed_supply': random.randint(1, 20),
            'total_supply': random.randint(50, 500)
        })
 
    def _trigger_random_event(self) -> Optional[dict]:
        """Dispara un evento de mercado aleatorio (10% de probabilidad por tick)."""
        if random.random() > 0.10:
            return None
        event = random.choice(self.MARKET_EVENTS).copy()
        event['started_at'] = time.time()
        event['ends_at'] = time.time() + event['duration']
        self.active_events.append(event)
        print(f"\n[MarketEvent] ⚡ {event['name']} por {event['duration']}s!")
        return event
 
    def _apply_active_events(self, item: dict) -> dict:
        """Aplica efectos de eventos activos a los parámetros del tick."""
        now = time.time()
        self.active_events = [e for e in self.active_events if e['ends_at'] > now]
        
        modifiers = {'volume': 1.0, 'users': 1.0, 'supply': 1.0}
        
        for event in self.active_events:
            effect = event['effect']
            mag = event['magnitude']
            if effect == 'volume_spike':
                modifiers['volume'] *= mag
            elif effect == 'user_surge':
                modifiers['users'] *= mag
            elif effect == 'supply_flood':
                modifiers['supply'] *= mag
            elif effect == 'price_spike':
                item['tier'].current_supply = max(0, item['tier'].current_supply - 1)
            elif effect == 'price_crash':
                modifiers['volume'] *= 0.1
                modifiers['supply'] *= 3
 
        return modifiers
 
    def tick(self) -> list[dict]:
        """
        Ejecuta un tick de simulación.
        Retorna el estado actual de todos los ítems.
        """
        self.tick_count += 1
        now = time.time()
 
        # Fluctuación de usuarios activos
        self._active_users = max(
            10,
            self._active_users + np.random.normal(0, 10)
        )
 
        # Posible evento de mercado
        self._trigger_random_event()
 
        results = []
        for item in self.items:
            engine = self.engines[item['id']]
            mods = self._apply_active_events(item)
 
            # Simular transacciones del tick
            base_tx_volume = random.uniform(0, 3) * item['tier'].base_price
            tx_volume = base_tx_volume * mods['volume']
            active_users = int(self._active_users * mods['users'])
            listed_supply = max(1, int(item['listed_supply'] * mods['supply']))
 
            # Calcular nuevo precio
            new_price = engine.calculate_new_price(
                tx_volume=tx_volume,
                active_users=active_users,
                listed_supply=listed_supply,
                total_supply=item['total_supply']
            )
 
            # Registrar tick
            tick = MarketTick(
                item_id=item['id'],
                price=new_price,
                volume=tx_volume,
                timestamp=now
            )
            self.aggregator.add_tick(tick)
 
            # Actualizar supply aleatorio
            if random.random() < 0.1:
                item['listed_supply'] = max(0, item['listed_supply'] + random.randint(-2, 3))
 
            results.append({
                'item_id': item['id'],
                'name': item['name'],
                'rarity': item['tier'].name,
                'color': item['tier'].color_hex,
                'price': new_price,
                'volume': round(tx_volume, 2),
                'change_pct': round(engine.price_change_24h, 2),
                'inflation_index': round(engine.inflation_index, 4),
                'listed_supply': item['listed_supply'],
                'active_users': active_users,
                'active_events': [e['name'] for e in self.active_events],
                'candles': self.aggregator.get_candles(item['id'], 60, 60)
            })
 
        return results
 
    async def run_async(self, tick_interval: float = 2.0, on_tick=None):
        """Corre el simulador de forma asíncrona."""
        self._is_running = True
        print(f"[MarketSimulator] Iniciando con {len(self.items)} items, tick={tick_interval}s")
        while self._is_running:
            state = self.tick()
            if on_tick:
                await on_tick(state)
            await asyncio.sleep(tick_interval)
 
    def stop(self):
        self._is_running = False
 
 
# ─────────────────────────────────────────────────────────────────────────────
# DEMO / ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────
 
def create_demo_simulator() -> MarketSimulator:
    """Crea un simulador con ítems de ejemplo para demo."""
    sim = MarketSimulator()
 
    demo_items = [
        ('item-001', 'Iron Sword',        DropEngine.TIERS[0]),  # Common
        ('item-002', 'Silver Shield',     DropEngine.TIERS[1]),  # Uncommon
        ('item-003', 'Crystal Wand',      DropEngine.TIERS[2]),  # Rare
        ('item-004', 'Dragon Scale',      DropEngine.TIERS[3]),  # Epic
        ('item-005', 'Phoenix Feather',   DropEngine.TIERS[4]),  # Legendary
        ('item-006', 'Cosmic Fragment',   DropEngine.TIERS[5]),  # Mythic
    ]
 
    for item_id, name, tier in demo_items:
        sim.register_item(item_id, name, tier)
 
    return sim
 
 
async def main():
    """Demo interactiva del simulador."""
    print("=" * 60)
    print("  SIMULADOR DE ECONOMÍA BASADA EN ESCASEZ")
    print("  Engine Python - Demo")
    print("=" * 60)
 
    # Demostrar drop rates
    drop_engine = DropEngine()
    drop_engine.simulate_distribution(5_000)
 
    # Iniciar simulación
    sim = create_demo_simulator()
 
    print("\n[MarketSimulator] Corriendo 5 ticks de demo...\n")
    for i in range(5):
        results = sim.tick()
        print(f"\n── Tick {i+1} ──────────────────────────────────")
        for item in results:
            events_str = f" [{', '.join(item['active_events'])}]" if item['active_events'] else ""
            print(
                f"  {item['rarity']:<12} {item['name']:<20} "
                f"${item['price']:>12,.2f}  "
                f"{item['change_pct']:>+7.2f}%  "
                f"Inflation: {item['inflation_index']:.3f}x"
                f"{events_str}"
            )
        await asyncio.sleep(0.5)
 
    print("\n[Done] Simulador listo para conectar con el frontend WebSocket.")
 
 
if __name__ == "__main__":
    asyncio.run(main())
 