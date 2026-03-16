// ============================================================
//  FinanzasJuntos — Netlify Function: parse-pdf
//  Usa gemini-1.5-flash-8b (4M TPM free tier, ideal para PDFs grandes)
// ============================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Modelos en orden de fallback
const MODELS = [
  'gemini-1.5-flash-8b',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(apiKey, pdfBase64, modelIndex = 0, attempt = 1) {
  const model = MODELS[modelIndex];
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

  console.log(`Intento con ${model} (attempt ${attempt})...`);

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

  // Rate limit — reintentar con espera
  if (response.status === 429) {
    // Si quedan más modelos, probar el siguiente
    if (modelIndex < MODELS.length - 1) {
      console.log(`429 en ${model}, probando ${MODELS[modelIndex + 1]}...`);
      await sleep(3000);
      return callGemini(apiKey, pdfBase64, modelIndex + 1, 1);
    }
    // Mismo modelo, reintentar hasta 3 veces
    if (attempt < 3) {
      const wait = attempt * 20000;
      console.log(`429 en todos los modelos, esperando ${wait/1000}s...`);
      await sleep(wait);
      return callGemini(apiKey, pdfBase64, 0, attempt + 1);
    }
  }

  console.log(`Respuesta de ${model}: ${response.status}`);
  return response;
}

exports.handler = async function(event) {
  // CORS preflight
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

  // ~8MB en base64
  if (pdfBase64.length > 11 * 1024 * 1024) {
    return { statusCode: 413, body: JSON.stringify({ error: 'El PDF es demasiado grande (máximo ~8MB). Intentá con un rango de fechas menor.' }) };
  }

  const sizeKb = (pdfBase64.length / 1024).toFixed(0);
  console.log(`PDF recibido: ${sizeKb} KB en base64`);

  try {
    const response = await callGemini(GEMINI_KEY, pdfBase64);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Error final ${response.status}:`, errText.substring(0, 300));

      const msgs = {
        400: 'El PDF no pudo ser procesado. Asegurate de que sea un estado de cuenta válido y no esté protegido con contraseña.',
        401: 'API key inválida. Verificá GEMINI_API_KEY en Netlify.',
        403: 'Sin acceso a la API de Gemini. Verificá tu API key.',
        429: 'Límite de Gemini alcanzado. El PDF puede ser muy grande — intentá con un extracto de menos páginas, o esperá unos minutos.',
        500: 'Error interno de Gemini. Intentá de nuevo en unos minutos.',
      };

      return {
        statusCode: 502,
        body: JSON.stringify({ error: msgs[response.status] || `Error Gemini: ${response.status}` })
      };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.error('Respuesta vacía de Gemini:', JSON.stringify(data).substring(0, 300));
      return {
        statusCode: 422,
        body: JSON.stringify({ error: 'Gemini no encontró transacciones en el PDF. Verificá que sea un estado de cuenta bancario.' })
      };
    }

    // Limpiar markdown
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();

    let transactions;
    try {
      transactions = JSON.parse(clean);
    } catch(e) {
      console.error('JSON parse error. Raw:', clean.substring(0, 400));
      return {
        statusCode: 422,
        body: JSON.stringify({ error: 'No se pudo interpretar la respuesta de Gemini. Intentá de nuevo.' })
      };
    }

    if (!Array.isArray(transactions)) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Formato de respuesta inesperado.' }) };
    }

    // Filtrar entradas inválidas
    const valid = transactions.filter(t =>
      t.date &&
      t.description &&
      typeof t.amount === 'number' &&
      t.amount > 0 &&
      (t.type === 'income' || t.type === 'expense')
    );

    console.log(`Éxito: ${valid.length} transacciones válidas de ${transactions.length} totales`);

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
      body: JSON.stringify({ error: 'Error de conexión con Gemini: ' + e.message })
    };
  }
};