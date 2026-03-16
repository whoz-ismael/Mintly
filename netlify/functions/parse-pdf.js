// ============================================================
//  FinanzasJuntos — Netlify Function: parse-pdf
//  Modelo: gemini-2.5-flash-lite (1000 req/día gratis)
//  Extrae transacciones Y asigna categorías en una sola llamada
// ============================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(apiKey, pdfBase64, categories, modelIndex = 0, attempt = 1) {
  const model = MODELS[modelIndex] || MODELS[0];
  const year  = new Date().getFullYear();

  // Construir la lista de categorías para el prompt
  const categoryNames = categories && categories.length > 0
    ? categories.map(c => c.name).join(', ')
    : 'Alimentación, Transporte, Hogar, Salud, Ocio, Ropa, Educación, Suscripciones, Viajes, Trabajo, Otros';

  const prompt = `Analizá este estado de cuenta bancario y extraé TODAS las transacciones.
Respondé SOLO con un array JSON válido, sin markdown, sin texto extra:
[{"date":"YYYY-MM-DD","description":"nombre del comercio","amount":123.45,"type":"expense o income","category":"nombre de categoría"}]

Reglas para los campos:
- amount: siempre positivo y mayor a cero
- type: "income" para depósitos, créditos, transferencias recibidas, nómina, intereses. "expense" para débitos, compras, pagos, cargos, retiros
- date: formato YYYY-MM-DD. Si no hay año, usá ${year}
- description: nombre limpio del comercio, sin códigos internos del banco
- category: asigná la categoría más apropiada de esta lista: ${categoryNames}. Si es un ingreso o no encaja en ninguna, usá "Otros". Si no estás seguro, dejá el campo vacío ""

No incluyas transacciones con monto 0.
Ignorá líneas de saldo, totales, encabezados y fechas de corte.`;

  console.log(`Usando ${model} (attempt ${attempt}), ${categories?.length || 0} categorías disponibles...`);

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

  if (response.status === 404 && modelIndex < MODELS.length - 1) {
    console.log(`${model} no disponible (404), probando ${MODELS[modelIndex + 1]}...`);
    return callGemini(apiKey, pdfBase64, categories, modelIndex + 1, attempt);
  }

  if (response.status === 429 && attempt < 3) {
    const wait = attempt * 20000;
    console.log(`Rate limit, esperando ${wait/1000}s...`);
    await sleep(wait);
    return callGemini(apiKey, pdfBase64, categories, modelIndex, attempt + 1);
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

  const { pdfBase64, categories } = body;
  if (!pdfBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el PDF' }) };
  }

  if (pdfBase64.length > 11 * 1024 * 1024) {
    return { statusCode: 413, body: JSON.stringify({ error: 'El PDF es demasiado grande (máximo ~8MB).' }) };
  }

  console.log(`PDF recibido: ${(pdfBase64.length / 1024).toFixed(0)} KB`);

  try {
    const response = await callGemini(GEMINI_KEY, pdfBase64, categories);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Error ${response.status}:`, errText.substring(0, 300));
      const msgs = {
        400: 'El PDF no pudo ser procesado. Verificá que sea un estado de cuenta válido y no esté protegido con contraseña.',
        401: 'API key inválida. Verificá GEMINI_API_KEY en Netlify.',
        403: 'Sin acceso a la API de Gemini.',
        404: 'Modelo de Gemini no disponible.',
        429: 'Límite de Gemini alcanzado. Esperá unos minutos e intentá de nuevo.',
        500: 'Error interno de Gemini. Intentá de nuevo.',
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
        body: JSON.stringify({ error: 'Gemini no encontró transacciones en el PDF.' })
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
        body: JSON.stringify({ error: 'No se pudo interpretar la respuesta. Intentá de nuevo.' })
      };
    }

    if (!Array.isArray(transactions)) {
      return { statusCode: 422, body: JSON.stringify({ error: 'Formato de respuesta inesperado.' }) };
    }

    // Filtrar entradas inválidas
    const valid = transactions.filter(t =>
      t.date && t.description &&
      typeof t.amount === 'number' && t.amount > 0 &&
      (t.type === 'income' || t.type === 'expense')
    );

    const withCategory = valid.filter(t => t.category && t.category !== '').length;
    console.log(`Éxito: ${valid.length} transacciones, ${withCategory} con categoría asignada`);

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