// ============================================================
//  FinanzasJuntos — Tasas de cambio
//  Obtiene de internet UNA vez por día, el resto del tiempo
//  usa el caché de Supabase.
// ============================================================

const Rates = {
  // Caché local en memoria para la sesión actual
  _cache: {},

  // Devuelve cuántos USD vale 1 unidad de la divisa dada
  // Ej: getRate('DOP') → 0.01709  (1 DOP = 0.01709 USD)
  async getRate(currency) {
    if (currency === 'USD') return 1;
    if (this._cache[currency]) return this._cache[currency];

    // 1. Buscar en Supabase
    const { data } = await supabase
      .from('exchange_rates')
      .select('*')
      .eq('currency', currency)
      .single();

    if (data) {
      const fetchedAt = new Date(data.fetched_at);
      const hoursOld = (Date.now() - fetchedAt.getTime()) / (1000 * 60 * 60);

      // Si tiene menos de 24 horas, usar el caché
      if (hoursOld < RATE_CACHE_HOURS) {
        this._cache[currency] = parseFloat(data.rate_to_usd);
        return this._cache[currency];
      }
    }

    // 2. Si no hay caché o está vencido, buscar en internet
    return await this._fetchFromAPI(currency);
  },

  async _fetchFromAPI(currency) {
    try {
      const res = await fetch(EXCHANGE_API_URL);
      const json = await res.json();
      const rates = json.rates; // rates[currency] = cuántas unidades de esa divisa vale 1 USD

      // Convertir: queremos cuántos USD vale 1 unidad de la divisa
      const rateToUsd = 1 / rates[currency];

      // Guardar en Supabase (upsert para actualizar si ya existe)
      await sb.from('exchange_rates').upsert({
        currency,
        rate_to_usd: rateToUsd,
        fetched_at: new Date().toISOString()
      }, { onConflict: 'currency' });

      this._cache[currency] = rateToUsd;
      return rateToUsd;
    } catch (e) {
      console.error('Error obteniendo tasa de cambio:', e);
      // Si falla, devolver 1 como fallback para no romper la app
      return 1;
    }
  },

  // Convierte un monto de cualquier divisa a USD
  async toUSD(amount, currency) {
    if (currency === 'USD') return amount;
    const rate = await this.getRate(currency);
    return parseFloat((amount * rate).toFixed(2));
  },

  // Devuelve el símbolo de la divisa
  symbol(currency) {
    const symbols = {
      USD: '$', DOP: 'RD$', EUR: '€', GBP: '£',
      CAD: 'CA$', MXN: 'MX$', ARS: '$', COP: '$',
      BRL: 'R$', CLP: '$', PEN: 'S/', UYU: '$U'
    };
    return symbols[currency] || currency;
  },

  // Formatea un monto con su símbolo
  format(amount, currency = 'USD') {
    const sym = this.symbol(currency);
    const formatted = Math.abs(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return `${sym}${formatted}`;
  }
};