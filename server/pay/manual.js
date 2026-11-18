'use strict';
/* =========================================================
   pay/manual.js — 人工确认通道（默认通道）
   ---------------------------------------------------------
   适用：还没开通商户号，但需要真实收款。
   流程：前端展示收款码 → 客户扫码转账 → 后台「确认到账」→ 履约发额度。
   合规：个人收款码/对公转账都合法，只是不能自动对账。
   ========================================================= */

function env(k, dft) {
  const v = process.env[k];
  return (v == null || v === '') ? (dft || '') : String(v).trim();
}

module.exports = {
  id: 'manual',

  configured() {
    return !!env('PAY_MANUAL_QR_URL') || !!env('PAY_MANUAL_ACCOUNT');
  },

  create(order) {
    const qr = env('PAY_MANUAL_QR_URL');
    const acct = env('PAY_MANUAL_ACCOUNT');
    const note = env('PAY_MANUAL_NOTE', '转账后请联系客服确认到账，通常 10 分钟内开通');
    return {
      provider: 'manual',
      status: qr || acct ? 'manual' : 'not_configured',
      payMode: 'manual',
      payUrl: qr,
      qrUrl: qr,
      account: acct,
      amount: order.amount,
      message: (qr || acct)
        ? ('请扫码/转账 ¥' + order.amount + '，备注订单号 ' + order.orderNo + '。' + note)
        : '未配置收款信息（PAY_MANUAL_QR_URL / PAY_MANUAL_ACCOUNT）。订单已生成，配置后即可收款。',
      canConfirm: false
    };
  },

  verifyNotify() {
    return { ok: false, code: 'MANUAL_NO_NOTIFY', message: '人工通道无异步回调，请在后台确认到账' };
  },

  diagnose() {
    const qr = env('PAY_MANUAL_QR_URL');
    const acct = env('PAY_MANUAL_ACCOUNT');
    return [
      { key: 'PAY_MANUAL_QR_URL', ok: !!qr, message: qr ? '已配置收款码' : '未配置收款码图片地址（可选）' },
      { key: 'PAY_MANUAL_ACCOUNT', ok: !!acct, message: acct ? ('收款账户：' + acct) : '未配置转账账户信息（可选）' },
      { key: 'PAY_PROVIDER', ok: true, message: '人工确认通道：客户付款后需在后台点「确认到账」' }
    ];
  }
};
