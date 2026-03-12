// ============================================================
//  FinanzasJuntos — Configuración de Supabase
// ============================================================

const SUPABASE_URL = 'https://kidczvzfmhkdzxigfntz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ITugv2zhaAF19LjT7QPOBg_crwlF_dP';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Divisa base siempre es USD
const BASE_CURRENCY = 'USD';

// API de tasas de cambio (gratis, 1500 req/mes)
const EXCHANGE_API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

// Horas mínimas entre actualizaciones de tasa
const RATE_CACHE_HOURS = 24;
