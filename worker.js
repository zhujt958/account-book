/**
 * 素龙记账 - Cloudflare Workers 后端
 * 功能：邮箱验证码登录 + JWT鉴权 + KV数据同步
 */

// ===== 配置（部署后通过 wrangler secret 设置）=====
// RESEND_API_KEY: Resend 邮件服务 API Key
// JWT_SECRET: JWT 签名密钥（随机字符串）
// KV_NAMESPACE: 绑定的 KV Namespace

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ===== 主入口 =====
export default {
  async fetch(request, env) {
    // 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // 路由
      if (path === '/api/send-code' && method === 'POST') {
        return await handleSendCode(request, env);
      }
      if (path === '/api/verify-code' && method === 'POST') {
        return await handleVerifyCode(request, env);
      }
      if (path === '/api/sync' && method === 'GET') {
        return await handleGetSync(request, env);
      }
      if (path === '/api/sync' && method === 'POST') {
        return await handlePostSync(request, env);
      }
      if (path === '/api/user' && method === 'GET') {
        return await handleGetUser(request, env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

// ===== 发送验证码 =====
async function handleSendCode(request, env) {
  const { email } = await request.json();
  if (!email || !isValidEmail(email)) {
    return json({ error: '请输入有效的邮箱地址' }, 400);
  }

  // 生成6位验证码
  const code = String(Math.floor(100000 + Math.random() * 900000));

  // 存入 KV，5分钟过期
  await env.ACCOUNT_BOOK_KV.put(`code:${email}`, code, { expirationTtl: 300 });

  // 发送邮件
  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: '记账本 <noreply@resend.dev>',
      to: email,
      subject: '【记账本】您的登录验证码',
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px">
          <h2 style="color:#e8a0aa">📖 记账本</h2>
          <p>您的登录验证码是：</p>
          <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#e8a0aa;background:#fff5f7;padding:16px;border-radius:12px;text-align:center;margin:16px 0">
            ${code}
          </div>
          <p style="color:#999;font-size:12px">验证码5分钟内有效，请勿告知他人。</p>
        </div>
      `,
    }),
  });

  if (!resendResponse.ok) {
    const err = await resendResponse.text();
    return json({ error: '邮件发送失败，请稍后重试' }, 500);
  }

  return json({ success: true, message: '验证码已发送到您的邮箱' });
}

// ===== 验证码校验 + 登录 =====
async function handleVerifyCode(request, env) {
  const { email, code } = await request.json();
  if (!email || !code) {
    return json({ error: '请输入邮箱和验证码' }, 400);
  }

  // 从 KV 读取验证码
  const storedCode = await env.ACCOUNT_BOOK_KV.get(`code:${email}`);
  if (!storedCode) {
    return json({ error: '验证码已过期，请重新发送' }, 400);
  }
  if (storedCode !== code) {
    return json({ error: '验证码不正确' }, 400);
  }

  // 验证成功，删除验证码
  await env.ACCOUNT_BOOK_KV.delete(`code:${email}`);

  // 生成 JWT token
  const token = generateToken();
  // token 存入 KV，30天过期
  await env.ACCOUNT_BOOK_KV.put(`token:${token}`, email, { expirationTtl: 2592000 });

  return json({ success: true, token: token, email: email });
}

// ===== 拉取云端数据 =====
async function handleGetSync(request, env) {
  const email = await authenticate(request, env);
  if (!email) return json({ error: '未登录或登录已过期' }, 401);

  const data = await env.ACCOUNT_BOOK_KV.get(`user:${email}`, 'json');
  return json({ success: true, data: data || null });
}

// ===== 上传数据到云端 =====
async function handlePostSync(request, env) {
  const email = await authenticate(request, env);
  if (!email) return json({ error: '未登录或登录已过期' }, 401);

  const body = await request.json();
  const { data } = body;

  if (!data || !data.records) {
    return json({ error: '数据格式错误' }, 400);
  }

  await env.ACCOUNT_BOOK_KV.put(`user:${email}`, JSON.stringify(data));
  return json({ success: true, message: '同步成功' });
}

// ===== 获取用户信息 =====
async function handleGetUser(request, env) {
  const email = await authenticate(request, env);
  if (!email) return json({ error: '未登录' }, 401);

  return json({ success: true, email: email });
}

// ===== JWT 鉴权 =====
async function authenticate(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7);
  const email = await env.ACCOUNT_BOOK_KV.get(`token:${token}`);
  return email;
}

// ===== 工具函数 =====
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 48; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token + Date.now().toString(36);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
