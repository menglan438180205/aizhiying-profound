'use strict';
/* =========================================================
   pay/mock.js — 自测通道（不发任何真实请求）
   ---------------------------------------------------------
   用途：把「下单 → 支付 → 履约 → 额度生效」整条链路跑通，
         不需要商户号、不需要资质。
   红线：只有 PAY_PROVIDER=mock 时才会被加载；生产环境默认 manual，
         绝不会出现「没付钱却显示已支付」的假象。
   ========================================================= */

module.exports = {
  id: 'mock',

  configured() { return true; },

  create(order) {
    return {
      provider: 'mock',
      status: 'ready',
      payMode: 'mock',
      payUrl: '',
      qrText: 'MOCK:' + order.orderNo,
      amount: order.amount,
      message: '模拟支付通道：确认订单后调用 /v1/billing/orders/' + order.orderNo + '/pay 即可完成',
      canConfirm: true
    };
  },

  verifyNotify() {
    return { ok: false, code: 'MOCK_NO_NOTIFY', message: '模拟通道没有异步回调，请调用 /pay 主动确认' };
  },

  diagnose() {
    return [
      { key: 'PAY_PROVIDER', ok: true, message: '当前为模拟通道（mock），不会产生真实收款' }
    ];
  }
};
