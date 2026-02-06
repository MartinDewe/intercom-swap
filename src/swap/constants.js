export const SWAP_PROTOCOL_VERSION = 1;

export const ASSET = Object.freeze({
  BTC_LN: 'BTC_LN',
  USDT_SOL: 'USDT_SOL',
});

export const PAIR = Object.freeze({
  BTC_LN__USDT_SOL: 'BTC_LN/USDT_SOL',
});

export const KIND = Object.freeze({
  SVC_ANNOUNCE: 'swap.svc_announce',
  RFQ: 'swap.rfq',
  QUOTE: 'swap.quote',
  QUOTE_ACCEPT: 'swap.quote_accept',
  SWAP_INVITE: 'swap.swap_invite',

  TERMS: 'swap.terms',
  ACCEPT: 'swap.accept',
  CANCEL: 'swap.cancel',
  STATUS: 'swap.status',

  LN_INVOICE: 'swap.ln_invoice',
  SOL_ESCROW_CREATED: 'swap.sol_escrow_created',
  LN_PAID: 'swap.ln_paid',
  SOL_CLAIMED: 'swap.sol_claimed',
  SOL_REFUNDED: 'swap.sol_refunded',
});

export const STATE = Object.freeze({
  INIT: 'init',
  TERMS: 'terms',
  ACCEPTED: 'accepted',
  INVOICE: 'invoice',
  ESCROW: 'escrow',
  LN_PAID: 'ln_paid',
  CLAIMED: 'claimed',
  REFUNDED: 'refunded',
  CANCELED: 'canceled',
});
