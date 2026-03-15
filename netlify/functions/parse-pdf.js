// ============================================================
//  FinanzasJuntos — Netlify Function: parse-pdf
//  Recibe un PDF en base64, lo manda a Gemini y devuelve
//  las transacciones extraídas como JSON.
// ============================================================

exports.handler = async function(event) {
  // Solo POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY no configurada' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  const { pdfBase64, currency } = body;
  if (!pdfBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta pdfBase64' }) };
  }

  const prompt = `Analizá este estado de cuenta bancario y extraé TODAS las transacciones.
Respondé SOLO con un array JSON válido, sin markdown, sin texto extra, con este formato exacto:
[{"date":"YYYY-MM-DD","description":"nombre del comercio o concepto","amount":123.45,"type":"expense o income"}]

Reglas:
- amount siempre positivo
- type = "income" para depósitos, créditos, transferencias recibidas, nómina
- type = "expense" para débitos, compras, pagos, cargos
- date en formato YYYY-MM-DD
- Si no hay año en el estado, usá el año actual
- description: nombre limpio sin códigos internos del banco
- Ignorá líneas de saldo, totales, encabezados y fechas de corte`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
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
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini error:', err);
      return { statusCode: 502, body: JSON.stringify({ error: 'Error de Gemini: ' + response.status }) };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    // Limpiar posibles backticks de markdown
    const clean = text.replace(/```json|```/g, '').trim();

    let transactions;
    try {
      transactions = JSON.parse(clean);
    } catch(e) {
      console.error('JSON parse error:', clean.substring(0, 200));
      return { statusCode: 422, body: JSON.stringify({ error: 'Gemini no devolvió JSON válido', raw: clean.substring(0, 500) }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions, count: transactions.length })
    };

  } catch(e) {
    console.error('Fetch error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Error interno: ' + e.message }) };
  }
};