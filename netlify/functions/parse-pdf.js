// ============================================================
//  FinanzasJuntos — Netlify Function: parse-pdf
//  Modelo: gemini-2.5-flash-lite (1000 req/día gratis)
// ============================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Modelos actuales del free tier (2025+), en orden de preferencia
const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(apiKey, pdfBase64, modelIndex = 0, attempt = 1) {
  const model = MODELS[modelIndex] || MODELS[0];
  const year  = new Date().getFullYear();

  const prompt = `Analizá este estado de cuenta bancario y extraé TODAS las transacciones.
Respondé SOLO con un array JSON válido, sin markdown, sin texto extra:
[{"date":"YYYY-MM-DD","description":"nombre del comercio","amount":123.45,"type":"expense o income"}]

Reglas:
- amount siempre positivo y mayor a cero
- type = "income" para depositos, creditos, transferencias recibidas, nomina, intereses
- type = "expense" para debitos, compras, pagos, cargos, retiros
- date en formato YYYY-MM-DD, si no hay año usa ${year}
- description: nombre limpio sin codigos internos del banco
- Ignora saldos, totales, encabezados y fechas de corte`;

  console.log(`Usando ${model} (attempt ${attempt})...`);

  const response = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
            { text: prompt }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
      })
    }
  );

  // 404 = modelo no disponible → probar el siguiente
  if (response.status === 404 && modelIndex < MODELS.length - 1) {
    console.log(`${model} no disponible (404), probando ${MODELS[modelIndex + 1]}...`);
    return callGemini(apiKey, pdfBase64, modelIndex + 1, attempt);
  }

  // 429 = rate limit → esperar y reintentar
  if (response.status === 429 && attempt < 3) {
    const wait = attempt * 20000;
    console.log(`Rate limit, esperando ${wait/1000}s...`);
    await sleep(wait);
    return callGemini(apiKey, pdfBase64, modelIndex, attempt + 1);
  }

  console.log(`Respuesta de ${model}: ${response.status}`);
  return response;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY no configurada en Netlify' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  const { pdfBase64 } = body;
  if (!pdfBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el PDF' }) };
  }

  if (pdfBase64.length > 11 * 1024 * 1024) {
    return { statusCode: 413, body: JSON.stringify({ error: 'El PDF es demasiado grande (máximo ~8MB).' }) };
  }

  console.log(`PDF recibido: ${(pdfBase64.length / 1024).toFixed(0)} KB`);

  try {
    const response = await callGemini(GEMINI_KEY, pdfBase64);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Error ${response.status}:`, errText.substring(0, 300));

      const msgs = {
        400: 'El PDF no pudo ser procesado. Verificá que sea un estado de cuenta válido y no esté protegido con contraseña.',
        401: 'API key inválida. Verificá GEMINI_API_KEY en Netlify → Site configuration → Environment variables.',
        403: 'Sin acceso a la API de Gemini. Verificá tu API key en aistudio.google.com.',
        404: 'Modelo de Gemini no disponible. Contactá al soporte.',
        429: 'Límite de Gemini alcanzado. Esperá unos minutos e intentá de nuevo.',
        500: 'Error interno de Gemini. Intentá de nuevo en unos minutos.',
      };

      return {
        statusCode: 502,
        body: JSON.stringify({ error: msgs[response.status] || `Error Gemini ${response.status}` })
      };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return {
        statusCode: 422,
        body: JSON.stringify({ error: 'Gemini no encontró transacciones en el PDF. Verificá que sea un estado de cuenta bancario.' })
      };
    }

    const clean = text.replace(/```json\n?|\n?```/g, '').trim();

    let transactions;
    try {
      transactions = JSON.parse(clean);
    } catch(e) {
      console.error('JSON parse error:', clean.substring(0, 400));
      return {
        statusCode: 422,
        body: JSON.stringify({ error: 'No se pudo interpretar la respuesta de Gemini. Intentá de nuevo.' })
      };
    }

    if (!Array.isArray(transactions)) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Formato de respuesta inesperado.' }) };
    }

    const valid = transactions.filter(t =>
      t.date && t.description &&
      typeof t.amount === 'number' && t.amount > 0 &&
      (t.type === 'income' || t.type === 'expense')
    );

    console.log(`Éxito: ${valid.length} transacciones de ${transactions.length} totales`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ transactions: valid, count: valid.length })
    };

  } catch(e) {
    console.error('Error interno:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error de conexión: ' + e.message })
    };
  }
};