export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }

    const { name, email, message } = body || {};

    if (!name || !email || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name | email | message'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    const accessKey = process.env.WEB3FORMS_ACCESS_KEY;
    if (!accessKey) {
      console.error('WEB3FORMS_ACCESS_KEY is not set');
      return res.status(500).json({ success: false, error: 'Server config error' });
    }

    const response = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        access_key: accessKey,
        name,
        email,
        message,
        subject: `Portfolio Contact from ${name}`,
        from_name: name,
      }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      return res.status(200).json({ success: true });
    } else {
      return res.status(400).json({
        success: false,
        error: result.message || 'Submission failed'
      });
    }
  } catch (err) {
    console.error('Contact form error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
