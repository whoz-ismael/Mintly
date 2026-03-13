// ============================================================
//  FinanzasJuntos — Config Supabase
//  IMPORTANTE: guardamos createClient ANTES de pisar window.supabase
// ============================================================

const SUPABASE_URL = 'https://kidczvzfmhkdzxigfntz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZGN6dnpmbWhrZHp4aWdmbnR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyOTExNTQsImV4cCI6MjA4ODg2NzE1NH0.gNWpp_PxjFlSeYzHNWzujD1UQfdK8ocaHgNswy8atxU';

// Rescatar createClient antes de que se pise window.supabase
const _createClient = window.supabase.createClient.bind(window.supabase);

// Cliente principal — usado por db.js, rates.js, auth.js y app.html
const sb = _createClient(SUPABASE_URL, SUPABASE_KEY);

// Aliases para compatibilidad
window.sb       = sb;
window.supabase = sb;   // a partir de acá window.supabase ES el cliente

// Constantes globales
const BASE_CURRENCY    = 'USD';
const EXCHANGE_API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
const RATE_CACHE_HOURS = 24;