/**
 * server.js - FY Bot Multi-Client System
 * Supports multiple WhatsApp instances with access code verification
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : `http://localhost:${PORT}`);
const ADMIN_UI_TOKEN = process.env.ADMIN_UI_TOKEN || 'changeme-strong-token';
const SESSION_DIR = process.env.SESSION_DIR || './session';
const POLL_SECONDS = parseInt(process.env.POLL_SECONDS || '20', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10);

// endpoints used
const SHADOW_STK_URL = 'https://shadow-pay.top/api/v2/stkpush.php';
const SHADOW_STATUS_URL = 'https://shadow-pay.top/api/v2/status.php';
const STATUM_AIRTIME_URL = 'https://api.statum.co.ke/api/v2/airtime';

// file-backed storage
// Root-file storage: no routes/public/data folders required
const DATA_DIR = __dirname;
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const PACKAGES_FILE = path.join(DATA_DIR, 'packages.json');
const ENV_FILE = path.join(__dirname, '.env');

function readJson(file, fallback){ try{ if(!fs.existsSync(file)){ fs.writeFileSync(file, JSON.stringify(fallback, null, 2)); return fallback; } const raw = fs.readFileSync(file,'utf8'); return JSON.parse(raw || 'null') ?? fallback; } catch(e){ console.error('readJson', e); return fallback; } }
function writeJson(file, obj){ fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

let ORDERS = readJson(ORDERS_FILE, []);
let SETTINGS = readJson(SETTINGS_FILE, {
  app_name: 'FY Bot',
  bot_name: 'FY Bot',
  admin_whatsapp: process.env.ADMIN_WHATSAPP || '',
  access_code: '4262',
  order_prefix: 'KS-',
  statum_consumer_key: '',
  statum_consumer_secret: '',
  shadow_api_key: '',
  shadow_api_secret: '',
  shadow_account_id: '10',
  data_shadow_account_id: '',
  sms_shadow_account_id: '',
  mins_shadow_account_id: '',
  min_amount: '10',
  max_amount: '1500',
  discount_percent: '0',
  payment_poll_seconds: String(POLL_SECONDS),
  otp_enabled: 'false',
  textsms_api_key: '',
  textsms_partner_id: '',
  textsms_shortcode: 'TextSMS',
  admin_sms_alert_number: '0700393422',
  sms_alert_data: 'false',
  sms_alert_sms: 'false',
  sms_alert_mins: 'false',
  sms_alert_template: '{{txn_code}} Confirmed.on {{date}} at {{time}}Ksh{{amount}} received from {{recipient}} {{client_name}}. New Account balance is Ksh{{balance}}. Transaction cost, Ksh0.00.',
  sms_alert_txn_source: 'mpesa',
  footer_text: 'Powered by whatsapp-web.js • FY Bot System'
});

let CLIENTS_DATA = readJson(CLIENTS_FILE, {});
let PACKAGES = readJson(PACKAGES_FILE, { data: [], sms: [], mins: [] });
const DAILY_LIMITS_FILE = path.join(DATA_DIR, 'daily_limits.json');
let DAILY_LIMITS = readJson(DAILY_LIMITS_FILE, {});

function saveOrders(){ writeJson(ORDERS_FILE, ORDERS); }
function saveSettings(){ writeJson(SETTINGS_FILE, SETTINGS); }
function saveClients(){ writeJson(CLIENTS_FILE, CLIENTS_DATA); }
function savePackages(){ writeJson(PACKAGES_FILE, PACKAGES); }
function saveDailyLimits(){ writeJson(DAILY_LIMITS_FILE, DAILY_LIMITS); }

function getKenyaDateStr(){
  return new Date(Date.now() + 3*60*60*1000).toISOString().split('T')[0];
}
function checkDailyLimit(recipientPhone){
  const today = getKenyaDateStr();
  const e = DAILY_LIMITS[recipientPhone];
  if(!e || e.date !== today) return null;
  return e.purchases || [];
}
function recordDailyPurchase(recipientPhone, purchase){
  const today = getKenyaDateStr();
  if(!DAILY_LIMITS[recipientPhone] || DAILY_LIMITS[recipientPhone].date !== today){
    DAILY_LIMITS[recipientPhone] = { date: today, purchases: [] };
  }
  DAILY_LIMITS[recipientPhone].purchases.push(purchase);
  saveDailyLimits();
}

function now(){ return new Date().toISOString().replace('T',' ').replace('Z',''); }
function genOrderNo(){ return (SETTINGS.order_prefix || 'KS-') + Math.floor(Math.random() * 1e8).toString().padStart(8,'0'); }
function normalizePhone(p){ if(!p) return ''; let s = String(p).replace(/\D/g,''); if(/^254[0-9]{9}$/.test(s)) return s; if(/^0[0-9]{9}$/.test(s)) return '254'+s.substring(1); if(/^[0-9]{9}$/.test(s)) return '254'+s; return s; }
function toJid(phone){ if(!phone) return null; return phone.replace(/\D/g,'') + '@c.us'; }

async function safeReply(msg, text){
  try {
    if (!msg || !text) return;
    await msg.reply(text);
  } catch (e) {
    try {
      if (msg && msg.client && msg.from) await msg.client.sendMessage(msg.from, text);
    } catch (_) {}
  }
}

function prettyOrderStatus(status){
  const map = {
    pending_payment:      '⏳ Pending Payment',
    paid:                 '✅ Paid',
    payment_failed:       '❌ Payment Failed',
    payment_timeout:      '⏱️ Payment Timeout',
    failed_payment_init:  '❌ Failed to Initiate',
    bundle_processing:    '🔄 Bundle Processing',
    delivered:            '✅ Delivered',
    airtime_sent:         '📤 Airtime Sent',
    delivery_failed:      '⚠️ Delivery Failed',
  };
  return map[status] || status;
}

function prettyOrder(o){
  const typeMap = { airtime:'💸 Airtime', data:'📶 Data Bundle', sms:'💬 SMS Package', mins:'⏱️ Minutes Bundle' };
  const pkgList = PACKAGES[o.order_type] || [];
  const pkg = o.package_id ? pkgList.find(p => p.id === o.package_id) : null;
  const net = networkLabel(detectNetwork(o.recipient_number));

  const lines = [
    `📋 *Order Details*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `┃ 🔖 *Order:*     ${o.order_no}`,
    `┃ 🛒 *Service:*   ${typeMap[o.order_type] || o.order_type}`,
  ];
  if(pkg) lines.push(`┃ 📦 *Package:*   ${pkg.name}`);
  lines.push(`┃ 📡 *Network:*   ${net}`);
  lines.push(`┃ 📲 *Recipient:* +${o.recipient_number}`);
  lines.push(`┃ 💳 *Payer:*     +${o.payer_number}`);
  lines.push(`┃ 💰 *Amount:*    KES ${parseFloat(o.amount).toFixed(2)}`);
  lines.push(`┃ 💸 *You Paid:*  KES ${parseFloat(o.amount_payable).toFixed(2)}`);
  if(parseFloat(o.discount_percent) > 0) lines.push(`┃ 🎉 *Discount:*  ${o.discount_percent}% off`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`┃ 🔁 *Status:*    ${prettyOrderStatus(o.status)}`);
  if(o.transaction_code) lines.push(`┃ 🏷️ *M-Pesa:*    ${o.transaction_code}`);
  if(o.airtime_status) lines.push(`┃ 📤 *Delivery:*  ${prettyOrderStatus(o.airtime_status)}`);
  if(o.admin_status) lines.push(`┃ ✏️ *Admin:*      ${o.admin_status}`);
  if(o.admin_remark) lines.push(`┃ 💬 *Remark:*    ${o.admin_remark}`);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🕐 _Placed: ${o.created_at}_`);
  lines.push(``);
  lines.push(`_Type *00* for the main menu_`);
  return lines.join('\n');
}

// Shadow & Statum wrappers
async function shadowInitiate(apiKey, apiSecret, accountId, phone, amount, reference, description){
  try {
    const payload = { payment_account_id: parseInt(accountId||'0',10), phone, amount: parseFloat(amount), reference, description };
    const r = await axios.post(SHADOW_STK_URL, payload, { headers:{ 'X-API-Key': apiKey||'', 'X-API-Secret': apiSecret||'', 'Content-Type':'application/json' }, timeout:30000 });
    return r.data;
  } catch(e) {
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

async function shadowStatus(apiKey, apiSecret, checkout_request_id){
  try {
    const payload = { checkout_request_id };
    const r = await axios.post(SHADOW_STATUS_URL, payload, { headers:{ 'X-API-Key': apiKey||'', 'X-API-Secret': apiSecret||'', 'Content-Type':'application/json' }, timeout:20000 });
    return r.data;
  } catch(e) {
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

async function statumSend(consumerKey, consumerSecret, phone, amount){
  try {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const payload = { phone_number: phone, amount: String(amount) };
    const r = await axios.post(STATUM_AIRTIME_URL, payload, { headers:{ Authorization:`Basic ${auth}`, 'Content-Type':'application/json' }, timeout:30000 });
    return r.data;
  } catch(e) {
    return { success:false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// Network detection by Kenyan phone prefix
function detectNetwork(phone){
  const num = normalizePhone(phone);
  if(!/^254[0-9]{9}$/.test(num)) return 'unknown';
  const p3 = num.substring(3, 6);
  const SAFARICOM = ['700','701','702','703','704','705','706','707','708','709','710','711','712','713','714','715','716','717','718','719','720','721','722','723','724','725','726','727','728','729','740','741','742','743','744','745','746','748','749','757','758','759','768','769','790','791','792','793','794','795','796','797','798','799','110','111','112','113','114','115'];
  const AIRTEL = ['730','731','732','733','734','735','736','737','738','739','750','751','752','753','754','755','756','762','763','765','766','767','768','780','781','782','783','784','785','786','787','788','789','100','101','102','103','104','105','106','107','108','109'];
  const TELKOM = ['770','771','772','773','774','775','776','777','778','779'];
  const FAIBA = ['747'];
  if(SAFARICOM.includes(p3)) return 'safaricom';
  if(AIRTEL.includes(p3)) return 'airtel';
  if(TELKOM.includes(p3)) return 'telkom';
  if(FAIBA.includes(p3)) return 'faiba';
  return 'unknown';
}

function networkLabel(net){
  const map = { safaricom:'Safaricom 🟢', airtel:'Airtel 🔴', telkom:'Telkom 🔵', faiba:'Faiba 🟠', unknown:'Unknown ❓' };
  return map[net] || net;
}

// In-memory OTP store: phone -> { code, expiry }
const OTP_STORE = new Map();

// Send OTP via TextSMS API
async function sendOtp(phone){
  try {
    const apiKey = SETTINGS.textsms_api_key || '';
    const partnerID = SETTINGS.textsms_partner_id || '';
    const shortcode = SETTINGS.textsms_shortcode || 'TextSMS';
    if (!apiKey || !partnerID) return { success: false, message: 'TextSMS credentials not configured. Please contact admin.' };
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    OTP_STORE.set(phone, { code, expiry: Date.now() + 10 * 60 * 1000 });
    const message = `Your verification code is: ${code}. Valid for 10 minutes. Do not share this code with anyone.`;
    const r = await axios.post('https://sms.textsms.co.ke/api/services/sendsms/', {
      apikey: apiKey,
      partnerID,
      message,
      shortcode,
      mobile: phone
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    const resp = r.data && r.data.responses && r.data.responses[0];
    if (resp && (resp['respose-code'] === 200 || resp['response-description'] === 'Success')) {
      return { success: true };
    }
    return { success: false, message: (resp && resp['response-description']) || 'SMS delivery failed' };
  } catch(e) {
    return { success: false, message: e.response && e.response.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// Verify OTP locally
async function verifyOtp(phone, code){
  const entry = OTP_STORE.get(phone);
  if (!entry) return { success: false, message: 'No OTP found. Please request a new code.' };
  if (Date.now() > entry.expiry) {
    OTP_STORE.delete(phone);
    return { success: false, message: 'OTP expired. Please request a new code.' };
  }
  if (entry.code !== code.trim()) return { success: false, message: 'Invalid code.' };
  OTP_STORE.delete(phone);
  return { success: true, verified: true };
}

// Order management
function createOrder(payer, recipient, amount, discount, clientId, orderType, packageId, senderJid){
  const order = {
    id: uuidv4(),
    order_no: genOrderNo(),
    payer_number: payer,
    recipient_number: recipient,
    sender_jid: senderJid || null,
    amount: parseFloat(amount),
    amount_payable: parseFloat((amount - (amount * (parseFloat(discount||'0')/100))).toFixed(2)),
    discount_percent: parseFloat(discount||'0'),
    status: 'pending_payment',
    client_id: clientId,
    order_type: orderType || 'airtime',
    package_id: packageId || null,
    checkout_request_id: null,
    merchant_request_id: null,
    transaction_code: null,
    airtime_status: null,
    airtime_response: null,
    admin_status: '',
    admin_remark: '',
    created_at: now(),
    updated_at: now()
  };
  ORDERS.unshift(order);
  saveOrders();
  return order;
}

function updateOrderByCheckout(checkout, data){
  let changed=false;
  for(const o of ORDERS){ if(o.checkout_request_id && o.checkout_request_id===checkout){ Object.assign(o, data); o.updated_at=now(); changed=true; break; } }
  if(changed) saveOrders();
}

function updateOrderByNo(order_no, data){
  for(const o of ORDERS){ if(o.order_no===order_no){ Object.assign(o, data); o.updated_at=now(); saveOrders(); return o; } }
  return null;
}

function findOrder(order_no){ return ORDERS.find(x=>x.order_no===order_no) || null; }

// Pick correct shadow account ID based on order type
function getShadowAccountId(clientData, orderType){
  const ord = ORDERS.find(o => o.order_type === orderType);
  if(orderType === 'data'){
    return clientData?.dataShadowAccountId || SETTINGS.data_shadow_account_id || clientData?.shadowAccountId || SETTINGS.shadow_account_id || '10';
  }
  if(orderType === 'sms'){
    return clientData?.smsShadowAccountId || SETTINGS.sms_shadow_account_id || clientData?.shadowAccountId || SETTINGS.shadow_account_id || '10';
  }
  if(orderType === 'mins'){
    return clientData?.minsShadowAccountId || SETTINGS.mins_shadow_account_id || clientData?.shadowAccountId || SETTINGS.shadow_account_id || '10';
  }
  return clientData?.shadowAccountId || SETTINGS.shadow_account_id || '10';
}

// Poll payment and deliver
async function pollPayment(checkout_request_id, orderNo, pollSecondsOverride, clientId){
  const clientData = CLIENTS.get(clientId) || CLIENTS_DATA[clientId];
  const apiKey = clientData?.shadowApiKey || SETTINGS.shadow_api_key; 
  const apiSecret = clientData?.shadowApiSecret || SETTINGS.shadow_api_secret;
  const timeout = parseInt(pollSecondsOverride ?? SETTINGS.payment_poll_seconds ?? POLL_SECONDS, 10);
  const attempts = Math.ceil(timeout / POLL_INTERVAL);
  let paid=false; let tx=null;
  for(let i=0;i<attempts;i++){
    await new Promise(r=>setTimeout(r, POLL_INTERVAL*1000));
    try{
      const sres = await shadowStatus(apiKey, apiSecret, checkout_request_id);
      const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
      const tcode = sres.transaction_code || sres.transaction || sres.tx || null;
      if(tcode) tx = tcode;
      if(pstatus==='completed' || pstatus==='success' || tx){
        updateOrderByCheckout(checkout_request_id, { status: 'paid', transaction_code: tx || null });
        paid=true; break;
      }
      if(pstatus==='failed' || (sres.message && sres.message.toString().toLowerCase()==='failed')){
        const failReason = sres.ResultDesc || sres.result_description || sres.errorMessage ||
          (sres.message && sres.message.toLowerCase()!=='failed' ? sres.message : null) || null;
        updateOrderByCheckout(checkout_request_id, { status: 'payment_failed', failure_reason: failReason });
        break;
      }
    } catch(e){ console.warn('pollPayment error', e.message); }
  }
  return { paid, tx };
}

// Send instant notification to user via WhatsApp
async function notifyUser(clientId, toJid, message){
  try {
    const clientData = CLIENTS.get(clientId);
    if (!clientData || !clientData.client) {
      console.error('Client not found for notification:', clientId);
      return false;
    }
    await clientData.client.sendMessage(toJid, message);
    return true;
  } catch(e) {
    console.error('notifyUser error:', e.message);
    return false;
  }
}

async function deliverAirtime(orderNo, clientId){
  const ord = findOrder(orderNo);
  if(!ord) return { success:false, message:'Order not found' };
  
  const clientData = CLIENTS.get(clientId || ord.client_id) || CLIENTS_DATA[clientId || ord.client_id];
  const consumerKey = clientData?.statumConsumerKey || SETTINGS.statum_consumer_key;
  const consumerSecret = clientData?.statumConsumerSecret || SETTINGS.statum_consumer_secret;
  
  try{
    const sres = await statumSend(consumerKey, consumerSecret, ord.recipient_number, ord.amount);
    if((sres.status_code && parseInt(sres.status_code)===200) || sres.success===true){
      updateOrderByNo(orderNo, { airtime_status:'delivered', airtime_response: JSON.stringify(sres) });
      return { success:true, statum:sres };
    } else {
      updateOrderByNo(orderNo, { airtime_status:'delivery_failed', airtime_response: JSON.stringify(sres) });
      return { success:false, statum:sres };
    }
  } catch(e){
    updateOrderByNo(orderNo, { airtime_status:'delivery_failed', airtime_response: e.message });
    return { success:false, message: e.message };
  }
}

// ── Message builder helpers ──
function buildAirtimeConfirm(payer, recipient, amount, payable, disc){
  const net = networkLabel(detectNetwork(recipient));
  const discLine = disc > 0 ? `\n┃ 🎉 *Discount:*  ${disc}% off` : '';
  return `🛒 *Confirm Your Order*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ 💸 *Service:*   Airtime\n┃ 📡 *Network:*   ${net}\n┃ 📲 *Recipient:* +${recipient}\n┃ 💳 *Payer:*     +${payer}\n┃ 💰 *Amount:*    KES ${parseFloat(amount).toFixed(2)}${discLine}\n┃ 💸 *You Pay:*   KES ${parseFloat(payable).toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nReply *1* to confirm  •  *2* to cancel\n_0 ‹ Back  •  00 ‹ Main Menu_`;
}
function buildPkgConfirm(pkg, payer, recipient, disc, payable){
  const net = networkLabel(detectNetwork(recipient));
  const discLine = disc > 0 ? `\n┃ 🎉 *Discount:*  ${disc}% off` : '';
  return `🛒 *Confirm Your Order*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ 📦 *Package:*   ${pkg.name}\n┃ 📡 *Network:*   ${net}\n┃ 📲 *Recipient:* +${recipient}\n┃ 💳 *Payer:*     +${payer}\n┃ 💰 *Price:*     KES ${parseFloat(pkg.price).toFixed(2)}${discLine}\n┃ 💸 *You Pay:*   KES ${parseFloat(payable).toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nReply *1* to confirm  •  *2* to cancel\n_0 ‹ Back  •  00 ‹ Main Menu_`;
}
function buildStkSentMsg(order){
  return `📲 *M-Pesa Request Sent!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nCheck your phone right now 👇\n\n1️⃣ Open the *M-Pesa* notification\n2️⃣ Enter your *M-Pesa PIN*\n3️⃣ Tap *Confirm* to complete\n\n┃ 🔖 *Order:*   ${order.order_no}\n┃ 💸 *Amount:* KES ${parseFloat(order.amount_payable).toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏳ _We'll notify you the moment payment is confirmed._\n_No prompt? Check your network signal and try again._`;
}
function buildPaymentSuccessMsg(order, recipient, tx, clientData){
  const net = networkLabel(detectNetwork(recipient));
  return `✅ *Payment Received!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎉 *KES ${parseFloat(order.amount_payable).toFixed(2)}* confirmed!\n\n┃ 🔖 *Order:*     ${order.order_no}\n┃ 🏷️ *M-Pesa:*   ${tx||'Processing...'}\n┃ 📡 *Network:*   ${net}\n┃ 📲 *Sending To:* +${recipient}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚡ _Delivering your airtime now — hold tight!_`;
}
function buildAirtimeDeliveredMsg(order, recipient, tx, clientData){
  const bn = clientData?.botName||SETTINGS.bot_name||'FY Bot';
  const net = networkLabel(detectNetwork(recipient));
  return `🎉 *Airtime Delivered!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n⚡ *KES ${parseFloat(order.amount).toFixed(2)}* airtime sent to:\n📲 *+${recipient}* — ${net}\n\n┃ 🔖 *Order:*   ${order.order_no}\n┃ 🏷️ *M-Pesa:* ${tx||'N/A'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nThank you for using *${bn}*! 🙏\n⭐ _We're here 24/7 — come back anytime!_\n_Type *00* for the main menu._`;
}
function buildDeliveryFailedMsg(order, recipient, clientData){
  const adminNum = normalizePhone(clientData?.adminNumber||SETTINGS.admin_whatsapp||'');
  const contactLine = adminNum ? `\n┃ 📱 *Support:* +${adminNum}` : '';
  return `⚠️ *Delivery Hiccup*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nYour payment of *KES ${parseFloat(order.amount_payable).toFixed(2)}* was received ✅\nBut we ran into an issue sending airtime to *+${recipient}*.\n\n🔒 *Don't worry — your money is safe!*\n\n┃ 🔖 *Order:* ${order.order_no}${contactLine}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Share your order number with support and we'll sort it out right away._`;
}
function buildPaymentFailedMsg(order){
  const latestOrd = findOrder(order.order_no) || order;
  const providerReason = latestOrd.failure_reason
    ? `\n┃ 📋 *Reason:* _${latestOrd.failure_reason}_` : '';
  return `❌ *Payment Not Completed*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ 🔖 *Order:* ${order.order_no}${providerReason}\n\nThis can happen when:\n› Insufficient M-Pesa balance\n› Wrong PIN entered\n› You cancelled the prompt\n› Network hiccup\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Your account was *not* charged._\n_Type *00* to go back and try again._`;
}
function buildPaymentTimeoutMsg(order){
  return `⏱️ *Still Waiting for Payment*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ 🔖 *Order:* ${order.order_no}\n\n✅ *If you paid:* your order is processing.\n_Enter your order number to check status._\n\n❌ *If you didn't pay:* no worries!\n_Type *00* to start a new order._`;
}
function buildPkgPaymentSuccessMsg(order, pkg, recipient, tx){
  const svcLabel = order.order_type==='data'?'Data Bundle':order.order_type==='sms'?'SMS Package':'Minutes Bundle';
  const net = networkLabel(detectNetwork(recipient));
  return `✅ *Payment Received!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎉 *KES ${parseFloat(order.amount_payable).toFixed(2)}* confirmed!\n\n┃ 🔖 *Order:*     ${order.order_no}\n┃ 📦 *Package:*   ${pkg.name}\n┃ 🏷️ *M-Pesa:*   ${tx||'Processing...'}\n┃ 📡 *Network:*   ${net}\n┃ 📲 *Sending To:* +${recipient}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚡ _Your ${svcLabel} is being activated — you'll receive it shortly!_`;
}
function buildPkgPaymentFailedMsg(order, pkg){
  const latestOrd = findOrder(order.order_no) || order;
  const providerReason = latestOrd.failure_reason
    ? `\n┃ 📋 *Reason:* _${latestOrd.failure_reason}_` : '';
  return `❌ *Payment Not Completed*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ 🔖 *Order:*   ${order.order_no}\n┃ 📦 *Package:* ${pkg.name}${providerReason}\n\nThis can happen when:\n› Insufficient M-Pesa balance\n› Wrong PIN entered\n› You cancelled the prompt\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Your account was *not* charged._\n_Type *00* to go back and try again._`;
}
function buildPkgPaymentTimeoutMsg(order, pkg){
  return `⏱️ *Still Waiting for Payment*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ 🔖 *Order:*   ${order.order_no}\n┃ 📦 *Package:* ${pkg.name}\n\n✅ *If you paid:* your bundle is processing.\n_Enter your order number to check status._\n\n❌ *If you didn't pay:* no worries!\n_Type *00* to start a new order._`;
}

// ── Admin SMS Alert via TextSMS API ──
async function sendAdminSmsAlert(order, clientData){
  try {
    const category = order.order_type;
    if(!['data','sms','mins'].includes(category)) return;
    if(SETTINGS[`sms_alert_${category}`] !== 'true') return;
    const adminPhone = normalizePhone(SETTINGS.admin_sms_alert_number || '');
    if(!adminPhone) return;
    const apiKey = SETTINGS.textsms_api_key || '';
    const partnerID = SETTINGS.textsms_partner_id || '';
    const shortcode = SETTINGS.textsms_shortcode || 'TextSMS';
    if(!apiKey || !partnerID){ console.log('[SMS Alert] TextSMS credentials not configured'); return; }
    const template = SETTINGS.sms_alert_template || '{{txn_code}} Confirmed.on {{date}} at {{time}}Ksh{{amount}} received from {{recipient}} {{client_name}}. New Account balance is Ksh{{balance}}. Transaction cost, Ksh0.00.';
    const txnSource = SETTINGS.sms_alert_txn_source || 'mpesa';
    const txnCode = txnSource === 'order' ? order.order_no : (order.transaction_code || order.order_no);
    const kenya = new Date(Date.now() + 3*60*60*1000);
    const dateStr = `${kenya.getUTCDate()}/${kenya.getUTCMonth()+1}/${String(kenya.getUTCFullYear()).slice(-2)}`;
    let hrs = kenya.getUTCHours();
    const mins = String(kenya.getUTCMinutes()).padStart(2,'0');
    const ampm = hrs >= 12 ? 'PM' : 'AM';
    hrs = hrs % 12 || 12;
    const timeStr = `${hrs}:${mins} ${ampm}`;
    const amount = parseFloat(order.amount_payable || order.amount || 0);
    const balance = (amount + Math.random()*49.9 + 0.1).toFixed(2);
    const clientName = clientData?.botName || SETTINGS.app_name || 'FY Bot';
    const recipient = order.recipient_number || '';
    const message = template
      .replace(/\{\{txn_code\}\}/g, txnCode)
      .replace(/\{\{date\}\}/g, dateStr)
      .replace(/\{\{time\}\}/g, timeStr)
      .replace(/\{\{amount\}\}/g, amount.toFixed(2))
      .replace(/\{\{recipient\}\}/g, recipient)
      .replace(/\{\{payer\}\}/g, recipient)
      .replace(/\{\{client_name\}\}/g, clientName)
      .replace(/\{\{balance\}\}/g, balance);
    await axios.post('https://sms.textsms.co.ke/api/services/sendsms/', {
      apikey: apiKey,
      partnerID,
      message,
      shortcode,
      mobile: adminPhone
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    console.log(`[SMS Alert] Admin alert sent for ${order.order_no}`);
  } catch(e){ console.log('[SMS Alert] Failed:', e.message); }
}

// ----- Multi-Client WhatsApp Management -----
const CLIENTS = new Map();

// Resolve system Chromium path once at startup — fast, no blocking exec calls
const _resolveChromiumPath = (() => {
  const fsOnce = require('fs');
  let resolved = null;

  // 0. Honour explicit env override (set by Dockerfile, Railway, Koyeb, etc.)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    try {
      if (fsOnce.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        resolved = process.env.PUPPETEER_EXECUTABLE_PATH;
      }
    } catch(e) {}
  }

  // 1. Static path list — all instant filesystem checks, no shell calls
  if (!resolved) {
    const candidates = [
      // Nix profile symlink — resolve to real store path instantly
      ...((() => {
        try {
          const link = '/home/runner/.nix-profile/bin/chromium';
          const real = fsOnce.realpathSync(link);
          return [link, real];
        } catch(e) { return []; }
      })()),
      '/run/current-system/sw/bin/chromium',
      '/nix/var/nix/profiles/default/bin/chromium',
      // Docker / Render / Koyeb (Debian/Ubuntu apt)
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      // Google Chrome paths (Heroku buildpack, manual install)
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/app/.apt/usr/bin/google-chrome',
      '/app/.apt/usr/bin/chromium-browser',
      // Other common paths
      '/usr/local/bin/chromium',
      '/usr/local/bin/chromium-browser',
      '/snap/bin/chromium',
    ];

    for (const p of candidates) {
      try { if (p && fsOnce.existsSync(p)) { resolved = p; break; } } catch(e) {}
    }
  }

  // 2. Nix store scan — prefer official chromium over ungoogled, highest version first
  if (!resolved) {
    try {
      const nixStore = '/nix/store';
      const entries = fsOnce.readdirSync(nixStore);
      const found = [];
      for (const entry of entries) {
        if (!entry.includes('chromium') || entry.includes('.drv')) continue;
        const bin = `${nixStore}/${entry}/bin/chromium`;
        try { if (fsOnce.existsSync(bin)) found.push({ entry, bin }); } catch(e) {}
      }
      if (found.length) {
        found.sort((a, b) => {
          const aUG = a.entry.startsWith('ungoogled') ? 1 : 0;
          const bUG = b.entry.startsWith('ungoogled') ? 1 : 0;
          if (aUG !== bUG) return aUG - bUG;
          const ver = s => { const m = s.match(/(\d+)\.\d+\.\d+/); return m ? parseInt(m[1], 10) : 0; };
          return ver(b.entry) - ver(a.entry);
        });
        resolved = found[0].bin;
      }
    } catch(e) {}
  }

  // 3. Puppeteer's own downloaded Chrome (for Heroku or any platform that ran npm install
  //    without PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1)
  if (!resolved) {
    try {
      const puppeteer = require('puppeteer');
      const execPath = puppeteer.executablePath();
      if (execPath && fsOnce.existsSync(execPath)) resolved = execPath;
    } catch(e) {}
  }

  console.log(`[Chromium] Resolved path: ${resolved || 'not found — will use puppeteer default'}`);
  return resolved;
})();

function createWhatsAppClient(clientId, options = {}) {
  if (CLIENTS.has(clientId)) {
    return CLIENTS.get(clientId);
  }

  const chromiumPath = _resolveChromiumPath;
  console.log(`[${clientId}] Using Chromium: ${chromiumPath || 'puppeteer bundled'}`);

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-renderer-backgrounding',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-pings',
      '--disable-web-security',
      '--disable-site-isolation-trials',
      '--ignore-certificate-errors',
      '--window-size=1280,720'
    ]
  };
  if (chromiumPath) {
    puppeteerConfig.executablePath = chromiumPath;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: SESSION_DIR }),
    puppeteer: puppeteerConfig,
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023654503-alpha.html'
    }
  });

  const clientData = {
    client,
    id: clientId,
    status: 'initializing',
    lastQr: null,
    pairingPhone: options.pairingPhone || CLIENTS_DATA[clientId]?.pairingPhone || null,
    loginType: options.loginType || CLIENTS_DATA[clientId]?.loginType || 'qr',
    connectedNumber: null,
    sessions: new Map(),
    createdAt: now(),
    botName: CLIENTS_DATA[clientId]?.botName || SETTINGS.bot_name || 'FY Bot',
    adminNumber: CLIENTS_DATA[clientId]?.adminNumber || '',
    shadowAccountId: CLIENTS_DATA[clientId]?.shadowAccountId || SETTINGS.shadow_account_id || '10',
    shadowApiKey: CLIENTS_DATA[clientId]?.shadowApiKey || SETTINGS.shadow_api_key || '',
    shadowApiSecret: CLIENTS_DATA[clientId]?.shadowApiSecret || SETTINGS.shadow_api_secret || '',
    dataShadowAccountId: CLIENTS_DATA[clientId]?.dataShadowAccountId || SETTINGS.data_shadow_account_id || '',
    smsShadowAccountId: CLIENTS_DATA[clientId]?.smsShadowAccountId || SETTINGS.sms_shadow_account_id || '',
    minsShadowAccountId: CLIENTS_DATA[clientId]?.minsShadowAccountId || SETTINGS.mins_shadow_account_id || '',
    statumConsumerKey: CLIENTS_DATA[clientId]?.statumConsumerKey || SETTINGS.statum_consumer_key || '',
    statumConsumerSecret: CLIENTS_DATA[clientId]?.statumConsumerSecret || SETTINGS.statum_consumer_secret || '',
    bannedUsers: CLIENTS_DATA[clientId]?.bannedUsers || {},
    isPaused: CLIENTS_DATA[clientId]?.isPaused || false,
    initRetryCount: CLIENTS_DATA[clientId]?.initRetryCount || 0
  };

  // Store client data
  if (!CLIENTS_DATA[clientId]) {
    CLIENTS_DATA[clientId] = {
      id: clientId,
      botName: clientData.botName,
      adminNumber: clientData.adminNumber,
      shadowAccountId: clientData.shadowAccountId,
      shadowApiKey: clientData.shadowApiKey,
      shadowApiSecret: clientData.shadowApiSecret,
      dataShadowAccountId: clientData.dataShadowAccountId,
      smsShadowAccountId: clientData.smsShadowAccountId,
      minsShadowAccountId: clientData.minsShadowAccountId,
      statumConsumerKey: clientData.statumConsumerKey,
      statumConsumerSecret: clientData.statumConsumerSecret,
      createdAt: clientData.createdAt,
      status: 'active',
      bannedUsers: {},
      isPaused: false,
      initRetryCount: 0,
      loginType: clientData.loginType,
      pairingPhone: clientData.pairingPhone
    };
    saveClients();
  } else {
    if (clientData.loginType) CLIENTS_DATA[clientId].loginType = clientData.loginType;
    if (clientData.pairingPhone) CLIENTS_DATA[clientId].pairingPhone = clientData.pairingPhone;
  }

  // Helper to send alert to client-specific admin
  async function alertAdmin(text) {
    const adminNum = normalizePhone(CLIENTS_DATA[clientId]?.adminNumber || clientData.adminNumber || '');
    if (!adminNum) return;
    try {
      const to = toJid(adminNum);
      await client.sendMessage(to, text);
    } catch(e) {
      console.error('alertAdmin error for', clientId, e.message);
    }
  }

  client.on('qr', async qr => {
    try {
      clientData.lastQr = qr;
      clientData.status = 'qr_ready';

      if (clientData.pairingPhone) {
        console.log(`[${clientId}] Pairing code mode - requesting code for ${clientData.pairingPhone}`);
        try {
          const pairingCode = await client.requestPairingCode(clientData.pairingPhone);
          console.log(`[${clientId}] Pairing code: ${pairingCode}`);
          clientData.lastPairingCode = pairingCode;
          io.to(clientId).emit('pairing_code', { code: pairingCode, clientId, phone: clientData.pairingPhone });
        } catch(pe) {
          console.error(`[${clientId}] Pairing code request failed:`, pe.message);
          io.to(clientId).emit('pairing_error', { error: pe.message, clientId });
          // Fall back to QR
          qrcodeTerminal.generate(qr, { small: true });
          const dataUrl = await qrcode.toDataURL(qr);
          io.to(clientId).emit('qr', { url: dataUrl, clientId });
        }
      } else {
        qrcodeTerminal.generate(qr, { small: true });
        console.log(`[${clientId}] QR code generated - Scan in WhatsApp`);
        const dataUrl = await qrcode.toDataURL(qr);
        io.to(clientId).emit('qr', { url: dataUrl, clientId });
      }
    } catch(e) {
      console.error(`[${clientId}] QR handling error`, e);
    }
  });

  client.on('ready', async () => {
    console.log(`[${clientId}] WhatsApp client ready!`);
    clientData.status = 'connected';
    if (client.info && client.info.wid) {
      clientData.connectedNumber = client.info.wid.user;
    }
    io.to(clientId).emit('status', { connected: true, clientId });
    await alertAdmin(`✅ *${clientData.botName}* is online.`);
  });

  client.on('authenticated', () => console.log(`[${clientId}] Authenticated`));
  client.on('auth_failure', msg => {
    console.error(`[${clientId}] Auth failure:`, msg);
    clientData.status = 'auth_failed';
    io.to(clientId).emit('status', { connected: false, error: 'auth_failure', clientId });
    
    console.log(`[${clientId}] Clearing corrupted session and retrying in 10 seconds...`);
    setTimeout(async () => {
      if (CLIENTS.has(clientId) && clientData.status === 'auth_failed') {
        console.log(`[${clientId}] Destroying failed client and clearing session directory...`);
        try {
          await clientData.client.destroy();
          CLIENTS.delete(clientId);
          
          const sessionPath = path.join(SESSION_DIR, `session-${clientId}`);
          if (fs.existsSync(sessionPath)) {
            console.log(`[${clientId}] Removing corrupted session at ${sessionPath}`);
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          
          console.log(`[${clientId}] Creating fresh client (QR scan will be required)...`);
          const newClient = createWhatsAppClient(clientId);
        } catch (e) {
          console.error(`[${clientId}] Error during auth failure recovery:`, e.message);
        }
      }
    }, 10000);
  });

  client.on('disconnected', reason => {
    console.log(`[${clientId}] Disconnected:`, reason);
    clientData.status = 'disconnected';
    io.to(clientId).emit('status', { connected: false, clientId });
    
    console.log(`[${clientId}] Auto-reconnecting in 5 seconds...`);
    setTimeout(() => {
      if (CLIENTS.has(clientId) && clientData.status === 'disconnected') {
        console.log(`[${clientId}] Attempting to reconnect...`);
        try {
          clientData.client.initialize().catch(e => {
            console.error(`[${clientId}] Reconnect failed:`, e.message);
          });
        } catch (e) {
          console.error(`[${clientId}] Error during reconnect attempt:`, e.message);
        }
      }
    }, 5000);
  });

  // Message handler for this client
  client.on('message', async msg => {
    try {
      if (!msg || !msg.from || !msg.body) return;
      
      const from = msg.from;
      const fromPhone = (from || '').replace('@c.us', '').replace('@g.us', '');
      const body = (msg.body || '').trim();
      
      if (!body || from.endsWith('@g.us')) return;

      // Get client-specific admin number — always normalised to 254XXXXXXXXX
      const currentAdminNumber = normalizePhone(CLIENTS_DATA[clientId]?.adminNumber || clientData.adminNumber || '');
      
      // Check if bot is paused
      if (clientData.isPaused && fromPhone !== currentAdminNumber) {
        const pausedMsg = `⏸️ *Bot Temporarily Paused*\n\n⚠️ This bot is currently paused by the admin.\n\nPlease try again later or contact support${currentAdminNumber ? ':\n📱 +' + currentAdminNumber : '.'}`;
        await msg.reply(pausedMsg);
        return;
      }
      
      // Check if user is banned
      if (clientData.bannedUsers && clientData.bannedUsers[fromPhone] && fromPhone !== currentAdminNumber) {
        const banInfo = clientData.bannedUsers[fromPhone];
        const banMsg = `
🚫 *ACCESS DENIED*

⚠️ You have been banned from using this bot.

${banInfo.reason ? `📝 *Reason:* ${banInfo.reason}\n` : ''}${banInfo.bannedAt ? `📅 *Banned on:* ${banInfo.bannedAt}\n` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 *Contact Bot Owner:*
${currentAdminNumber ? '📱 WhatsApp: +' + currentAdminNumber : '📧 Please contact the bot administrator'}

_If you believe this is a mistake, please reach out to the owner._
        `.trim();
        await msg.reply(banMsg);
        return;
      }
      
      // ═══════════════════════════════════════════════════════
      // PER-CLIENT ADMIN PANEL (WhatsApp) — admin number only
      // ═══════════════════════════════════════════════════════
      if (currentAdminNumber && fromPhone === currentAdminNumber) {
        if (!clientData.sessions.has(fromPhone)) {
          clientData.sessions.set(fromPhone, { step: 'ADMIN_MENU', temp: {} });
        }
        const as = clientData.sessions.get(fromPhone);

        // Persist a field to this specific client only
        const saveClientField = (key, value) => {
          clientData[key] = value;
          if (CLIENTS_DATA[clientId]) { CLIENTS_DATA[clientId][key] = value; saveClients(); }
        };

        const sendAdminMenu = async () => {
          const bn = clientData.botName || SETTINGS.bot_name || 'FY Bot';
          const pauseLabel = clientData.isPaused ? '*8.* ▶️ Resume Bot' : '*8.* ⏸️  Pause Bot';
          const myOrders = ORDERS.filter(o => o.client_id === clientId);
          const pendingCount = myOrders.filter(o => o.status === 'pending_payment').length;
          const paidCount   = myOrders.filter(o => o.status === 'paid').length;
          const menu =
`╔═══════════════════════════╗
║   👑 *ADMIN PANEL*        ║
╚═══════════════════════════╝
🤖 Bot: *${bn}*

📊 *Today's Snapshot*
   ✅ Paid: *${paidCount}*  |  ⏳ Pending: *${pendingCount}*  |  📦 Total: *${myOrders.length}*

━━━━━━━━━━━━━━━━━━━━━━━━━━━
*📦 ORDERS*
*1.* View Recent Orders
*2.* Orders by Status
*3.* Update an Order Status

*⚙️ MY BOT SETTINGS*
*4.* View My Settings
*5.* Change Bot Name
*6.* Payment API (Shadow)
*7.* Airtime API (Statum)

*🔧 BOT CONTROLS*
${pauseLabel}
*0.* 👤 Switch to Customer Mode

━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Reply with a number_`;
          await msg.reply(menu);
          as.step = 'ADMIN_MENU';
          as.temp = {};
        };

        // Auto-detect: show admin panel when admin first messages or resets
        if (!as.step || as.step === 'MENU' || /^(admin|\/admin)$/i.test(body)) {
          await sendAdminMenu();
          return;
        }

        // ── ADMIN_MENU ──────────────────────────────────────
        if (as.step === 'ADMIN_MENU') {
          if (body === '0') {
            as.step = 'MENU'; as.temp = {};
            await msg.reply(`👤 *Switched to Customer Mode*\n\n_Type *admin* anytime to return to your admin panel._`);
            return;
          }
          if (body === '1') {
            const arr = ORDERS.filter(o => o.client_id === clientId).slice(0, 15);
            if (!arr.length) { await msg.reply(`📭 *No orders found for your bot yet.*\n\n_Type *admin* to go back._`); return; }
            const tIco = { airtime:'💸', data:'📶', sms:'💬', mins:'⏱️' };
            let out = `📋 *RECENT ORDERS* (${arr.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            arr.forEach((o, i) => {
              out += `\n*${i+1}.* *${o.order_no}*\n`;
              out += `   ${tIco[o.order_type]||'📦'} KES ${parseFloat(o.amount).toFixed(2)} — ${prettyOrderStatus(o.status)}\n`;
              out += `   📱 +${o.recipient_number}\n`;
            });
            out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Type any order number to view its details_\n_0 ← Back_`;
            await msg.reply(out);
            as.step = 'ADMIN_ORDER_FIND'; as.temp = {};
            return;
          }
          if (body === '2') {
            await msg.reply(`📊 *Orders by Status*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ *1* › ✅ Paid\n┃ *2* › ⏳ Pending Payment\n┃ *3* › ❌ Failed / Timeout\n┃ *4* › 🔄 Processing / Sent\n\n_0 ‹ Back_`);
            as.step = 'ADMIN_ORDERS_BY_STATUS';
            return;
          }
          if (body === '3') {
            await msg.reply(`📝 *UPDATE ORDER STATUS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nEnter the *order number* to update:\n\n✍️ Example: *${SETTINGS.order_prefix||'KS-'}12345678*\n\n_0 ← Back_`);
            as.step = 'ADMIN_ORDER_FIND'; as.temp = { action: 'update' };
            return;
          }
          if (body === '4') {
            const txt =
`⚙️ *MY BOT SETTINGS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

🤖 *Bot Name:*          ${clientData.botName || '—'}
📱 *Admin Number:*   +${clientData.adminNumber || '—'}

💳 *Shadow API Key:*    ${clientData.shadowApiKey    ? '✅ Set' : '❌ Not set'}
🔑 *Shadow Secret:*      ${clientData.shadowApiSecret ? '✅ Set' : '❌ Not set'}
🏦 *Main Account ID:*   ${clientData.shadowAccountId || '—'}
📶 *Data Account ID:*   ${clientData.dataShadowAccountId || '— (uses main)'}
💬 *SMS Account ID:*     ${clientData.smsShadowAccountId  || '— (uses main)'}
⏱️ *Mins Account ID:*    ${clientData.minsShadowAccountId || '— (uses main)'}

📡 *Statum Key:*         ${clientData.statumConsumerKey    ? '✅ Set' : '❌ Not set'}
🔐 *Statum Secret:*     ${clientData.statumConsumerSecret ? '✅ Set' : '❌ Not set'}

🔁 *Bot Status:*         ${clientData.isPaused ? '⏸️ Paused' : '✅ Active'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Type *admin* to go back_`;
            await msg.reply(txt);
            return;
          }
          if (body === '5') {
            await msg.reply(`✏️ *CHANGE BOT NAME*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nCurrent: *${clientData.botName || '—'}*\n\nEnter the *new bot name*:\n\n_0 ← Cancel_`);
            as.step = 'ADMIN_SET_VALUE';
            as.temp = { settingKey: 'botName', label: 'Bot Name' };
            return;
          }
          if (body === '6') {
            await msg.reply(`💳 *Payment API Settings*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Shadow Pay — for your bot only_\n\n┃ *1* › Shadow API Key\n┃ *2* › Shadow API Secret\n┃ *3* › Main Account ID\n┃ *4* › Data Bundle Account ID\n┃ *5* › SMS Package Account ID\n┃ *6* › Minutes Bundle Account ID\n\n_0 ‹ Back_`);
            as.step = 'ADMIN_SHADOW_MENU';
            return;
          }
          if (body === '7') {
            await msg.reply(`📡 *Airtime API Settings*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Statum — for your bot only_\n\n┃ *1* › Consumer Key\n┃ *2* › Consumer Secret\n\n_0 ‹ Back_`);
            as.step = 'ADMIN_STATUM_MENU';
            return;
          }
          if (body === '8') {
            clientData.isPaused = !clientData.isPaused;
            if (CLIENTS_DATA[clientId]) { CLIENTS_DATA[clientId].isPaused = clientData.isPaused; saveClients(); }
            const stateMsg = clientData.isPaused
              ? `⏸️ *Bot Paused*\n\n_Your bot will not respond to customers until you resume it._`
              : `▶️ *Bot Resumed*\n\n_Your bot is now live and accepting customer requests._`;
            await msg.reply(stateMsg + `\n\n_Type *admin* to go back to the admin panel._`);
            return;
          }
          await msg.reply(`❌ *Invalid option.*\n\n_Type *admin* to see the menu._`);
          return;
        }

        // ── ADMIN_ORDERS_BY_STATUS ──────────────────────────
        if (as.step === 'ADMIN_ORDERS_BY_STATUS') {
          if (body === '0') { await sendAdminMenu(); return; }
          const statusFilters = {
            '1': ['paid'],
            '2': ['pending_payment'],
            '3': ['payment_failed','payment_timeout','failed_payment_init'],
            '4': ['bundle_processing','airtime_sent','delivered'],
          };
          const filter = statusFilters[body];
          if (!filter) { await msg.reply(`❌ Reply *1–4* or *0* to go back.`); return; }
          const arr = ORDERS.filter(o => o.client_id === clientId && filter.includes(o.status)).slice(0, 15);
          if (!arr.length) { await msg.reply(`📭 *No orders with that status.*\n\n_0 ← Back_`); return; }
          const tIco = { airtime:'💸', data:'📶', sms:'💬', mins:'⏱️' };
          let out = `📊 *${prettyOrderStatus(filter[0]).toUpperCase()}* (${arr.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          arr.forEach((o, i) => {
            out += `\n*${i+1}.* *${o.order_no}*\n`;
            out += `   ${tIco[o.order_type]||'📦'} KES ${parseFloat(o.amount).toFixed(2)}\n`;
            out += `   📱 +${o.recipient_number}\n`;
          });
          out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Type an order number to view details_\n_0 ← Back_`;
          await msg.reply(out);
          as.step = 'ADMIN_ORDER_FIND';
          return;
        }

        // ── ADMIN_ORDER_FIND ────────────────────────────────
        if (as.step === 'ADMIN_ORDER_FIND') {
          if (body === '0') { await sendAdminMenu(); return; }
          const ord = findOrder(body.trim().toUpperCase());
          if (!ord || ord.client_id !== clientId) {
            await msg.reply(`❌ *Order not found.*\n\nPlease check the order number and try again.\n\n_0 ← Back_`);
            return;
          }
          const tMap = { airtime:'💸 Airtime', data:'📶 Data Bundle', sms:'💬 SMS Package', mins:'⏱️ Minutes Bundle' };
          const pkgL = PACKAGES[ord.order_type] || [];
          const pkg  = ord.package_id ? pkgL.find(p => p.id === ord.package_id) : null;
          let detail =
`╔═══════════════════════════╗
║  📦 *ORDER DETAIL*        ║
╚═══════════════════════════╝

📋 *Order:*      ${ord.order_no}
🛒 *Service:*   ${tMap[ord.order_type]||ord.order_type}${pkg?`\n📦 *Package:*   ${pkg.name}`:''}

💳 *Payer:*      +${ord.payer_number}
📱 *Recipient:* +${ord.recipient_number}
💰 *Amount:*    KES ${parseFloat(ord.amount).toFixed(2)}
💸 *Paid:*        KES ${parseFloat(ord.amount_payable).toFixed(2)}

🔁 *Status:*     ${prettyOrderStatus(ord.status)}${ord.transaction_code?`\n🏷️ *M-Pesa:*     ${ord.transaction_code}`:''}${ord.airtime_status?`\n📤 *Delivery:*   ${prettyOrderStatus(ord.airtime_status)}`:''}${ord.admin_status?`\n✏️ *Admin Note:* ${ord.admin_status}`:''}${ord.admin_remark?`\n💬 *Remark:*     ${ord.admin_remark}`:''}

⏱️ *Placed:*    ${ord.created_at}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
*1.* ✏️ Update Status & Note
*0.* ← Back`;
          as.temp = { ...as.temp, orderNo: ord.order_no };
          as.step = 'ADMIN_ORDER_DETAIL';
          await msg.reply(detail);
          return;
        }

        // ── ADMIN_ORDER_DETAIL ──────────────────────────────
        if (as.step === 'ADMIN_ORDER_DETAIL') {
          if (body === '0') { await sendAdminMenu(); return; }
          if (body === '1') {
            await safeReply(msg,
`✏️ *UPDATE ORDER STATUS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Order: *${as.temp.orderNo}*

Type the new status message to send to the customer:

_Examples:_
• Delivered ✅
• Processing — please wait
• Failed — contact support

_0 ← Cancel_`);
            as.step = 'ADMIN_ORDER_NEW_STATUS';
            return;
          }
          await msg.reply(`❌ Reply *1* to update or *0* to go back.`);
          return;
        }

        // ── ADMIN_ORDER_NEW_STATUS ──────────────────────────
        if (as.step === 'ADMIN_ORDER_NEW_STATUS') {
          if (body === '0') { await sendAdminMenu(); return; }
          as.temp.newStatus = body.trim();
          await safeReply(msg,
`💬 *ADD A REMARK* _(optional)_
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Enter a short note for the customer, or type *skip* to send without one.

_0 ← Cancel_`);
          as.step = 'ADMIN_ORDER_NEW_REMARK';
          return;
        }

        // ── ADMIN_ORDER_NEW_REMARK ──────────────────────────
        if (as.step === 'ADMIN_ORDER_NEW_REMARK') {
          if (body === '0') { await sendAdminMenu(); return; }
          const remark = /^skip$/i.test(body) ? '' : body.trim();
          const ord = findOrder(as.temp.orderNo);
          if (!ord || ord.client_id !== clientId) { await sendAdminMenu(); return; }
          ord.admin_status = as.temp.newStatus;
          if (remark) ord.admin_remark = remark;
          ord.updated_at = now();
          saveOrders();
          // Notify customer
          try {
            const tMapN = { airtime:'💸 Airtime', data:'📶 Data Bundle', sms:'💬 SMS Package', mins:'⏱️ Minutes Bundle' };
            const pkgLN = PACKAGES[ord.order_type] || [];
            const pkgN  = ord.package_id ? pkgLN.find(p => p.id === ord.package_id) : null;
            const notifMsg =
`🔔 *ORDER UPDATE*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 *Order:*      ${ord.order_no}
🛒 *Service:*   ${tMapN[ord.order_type]||ord.order_type}${pkgN?`\n📦 *Package:*   ${pkgN.name}`:''}
📱 *Recipient:* +${ord.recipient_number}
💸 *Amount:*    KES ${parseFloat(ord.amount_payable).toFixed(2)}

✏️ *Status:*    ${ord.admin_status}${remark?`\n💬 *Note:*       ${remark}`:''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Type *${ord.order_no}* to check full details_`;
            const uJid = ord.sender_jid || toJid(ord.payer_number);
            if (uJid) await notifyUser(clientId, uJid, notifMsg).catch(()=>{});
          } catch(ne){ console.error('admin notify error:', ne.message); }
          await safeReply(msg,
`✅ *Order Updated!*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 *Order:*   ${ord.order_no}
✏️ *Status:*  ${ord.admin_status}${remark?`\n💬 *Note:*    ${remark}`:''}

📲 _Customer has been notified._

━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Type *admin* to go back to the panel_`);
          as.step = 'ADMIN_MENU'; as.temp = {};
          return;
        }

        // ── ADMIN_SHADOW_MENU ───────────────────────────────
        if (as.step === 'ADMIN_SHADOW_MENU') {
          if (body === '0') { await sendAdminMenu(); return; }
          const shadowFields = {
            '1': { key:'shadowApiKey',        label:'Shadow API Key' },
            '2': { key:'shadowApiSecret',     label:'Shadow API Secret' },
            '3': { key:'shadowAccountId',     label:'Main Account ID' },
            '4': { key:'dataShadowAccountId', label:'Data Bundle Account ID' },
            '5': { key:'smsShadowAccountId',  label:'SMS Package Account ID' },
            '6': { key:'minsShadowAccountId', label:'Minutes Bundle Account ID' },
          };
          const fld = shadowFields[body];
          if (!fld) { await msg.reply(`❌ Reply *1–6* or *0* to go back.`); return; }
          const isSecret = fld.key.includes('Key') || fld.key.includes('Secret');
          const cur = isSecret ? (clientData[fld.key] ? '✅ Already set (hidden for security)' : '❌ Not set') : (clientData[fld.key] || '— not set');
          await msg.reply(`✏️ *${fld.label.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nCurrent: ${cur}\n\nEnter the *new value*:\n\n_0 ← Cancel_`);
          as.step = 'ADMIN_SET_VALUE';
          as.temp = { settingKey: fld.key, label: fld.label };
          return;
        }

        // ── ADMIN_STATUM_MENU ───────────────────────────────
        if (as.step === 'ADMIN_STATUM_MENU') {
          if (body === '0') { await sendAdminMenu(); return; }
          const statumFields = {
            '1': { key:'statumConsumerKey',    label:'Statum Consumer Key' },
            '2': { key:'statumConsumerSecret', label:'Statum Consumer Secret' },
          };
          const fld = statumFields[body];
          if (!fld) { await msg.reply(`❌ Reply *1–2* or *0* to go back.`); return; }
          const cur = clientData[fld.key] ? '✅ Already set (hidden for security)' : '❌ Not set';
          await msg.reply(`✏️ *${fld.label.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nCurrent: ${cur}\n\nEnter the *new value*:\n\n_0 ← Cancel_`);
          as.step = 'ADMIN_SET_VALUE';
          as.temp = { settingKey: fld.key, label: fld.label };
          return;
        }

        // ── ADMIN_SET_VALUE ─────────────────────────────────
        if (as.step === 'ADMIN_SET_VALUE') {
          if (body === '0') { await sendAdminMenu(); return; }
          const newVal = body.trim();
          if (!newVal) { await msg.reply(`❌ Please enter a valid value.\n\n_0 ← Cancel_`); return; }
          const key   = as.temp.settingKey;
          const label = as.temp.label || key;
          saveClientField(key, newVal);
          const isSecret = key.includes('Key') || key.includes('Secret') || key.includes('key') || key.includes('secret');
          await safeReply(msg,
`✅ *${label} Updated!*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

*${label}:* ${isSecret ? '✅ Saved securely (hidden)' : newVal}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Type *admin* to go back to the panel_`);
          as.step = 'ADMIN_MENU'; as.temp = {};
          return;
        }

        // Fallback — unknown admin step
        await sendAdminMenu();
        return;
      }

      // Regular user flow
      const isFirstVisit = !clientData.sessions.has(fromPhone);
      if (isFirstVisit) {
        clientData.sessions.set(fromPhone, { step: 'MENU', temp: {} });
        const bn = clientData.botName || 'FY Bot';
        const welcomeMsg = `👋 *Welcome to ${bn}!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHi there! 🌟 I'm your personal airtime & data assistant, available *24/7* just for you.\n\nHere's what I can do:\n┃ 💸 Buy airtime instantly\n┃ 📶 Data bundles\n┃ 💬 SMS packages\n┃ ⏱️ Minutes bundles\n\nAll payments via *M-Pesa* — fast, safe & easy! 🔒\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Reply with anything to see the menu 👇_`;
        await msg.reply(welcomeMsg);
        return;
      }
      const s = clientData.sessions.get(fromPhone);

      // Global resets: greetings, "menu", "00" → main menu
      if (/^(menu|hi|hello|hey|start|hallo|habari|hujambo|niaje|sasa|mambo)$/i.test(body) || body === '00') { s.step = 'MENU'; s.temp = {}; }

      // ── Inline helpers ──
      const sendMainMenu = async () => {
        const bn = clientData.botName || 'FY Bot';
        const adminLine = (currentAdminNumber && fromPhone === currentAdminNumber) ? '\n┃ *9* › 👑 Admin Panel' : '';
        const menu = `🤖 *${bn}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHello! 👋 How can I help you today?\nChoose a service below:\n\n┃ *1* › 💸 Buy Airtime\n┃ *2* › 📶 Data Bundles\n┃ *3* › 💬 SMS Packages\n┃ *4* › ⏱️ Minutes Bundles\n┃ *5* › 📦 Track My Order\n┃ *6* › ❓ Help & Support${adminLine}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Reply with a number to get started_`;
        await msg.reply(menu);
        s.step = 'AWAITING_MENU';
      };

      const sendPkgList = async (type) => {
        const icons = { data:'📶', sms:'💬', mins:'⏱️' };
        const titles = { data:'Data Bundles', sms:'SMS Packages', mins:'Minutes Bundles' };
        const pkgs = PACKAGES[type] || [];
        if(pkgs.length === 0){
          await msg.reply(`${icons[type]} *${titles[type]}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n😔 No packages available in this category yet.\nPlease check back soon!\n\n_Type *00* to return to the main menu._`);
          return false;
        }
        let listText = `${icons[type]} *${titles[type]}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nChoose a package:\n\n`;
        pkgs.forEach((p, i) => {
          const desc = p.description ? `\n     _${p.description}_` : '';
          listText += `┃ *${i+1}* › ${p.name}\n     💰 *KES ${p.price}*${desc}\n\n`;
        });
        listText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Reply with a number to select_\n_0 ‹ Back  •  00 ‹ Main Menu_`;
        await msg.reply(listText);
        return true;
      };

      switch (s.step) {
        case 'MENU': {
          await sendMainMenu();
          break;
        }

        case 'AWAITING_MENU': {
          if (body === '0') { await sendMainMenu(); return; }

          const OTP_MSG = `🔐 *Verification Required*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nFor your security, we need to verify your phone number.\n\n📱 Enter the number to receive your *OTP code* via SMS:\n_Format: 07XXXXXXXX or 254XXXXXXXXX_\n\n_0 ‹ Cancel  •  00 ‹ Main Menu_`;
          if (body === '1') {
            if (SETTINGS.otp_enabled === 'true' && !s.otpVerified) {
              s.temp = { afterOtp: 'BUY_AMOUNT' }; s.step = 'OTP_GET_PHONE';
              await msg.reply(OTP_MSG);
              return;
            }
            s.step = 'BUY_AMOUNT'; s.temp = {};
            await msg.reply(`💸 *Buy Airtime*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHow much airtime would you like to buy?\n\n💰 Enter amount in *KES*:\n_Min: KES ${SETTINGS.min_amount||'1'}  •  Max: KES ${SETTINGS.max_amount||'1500'}_\n\n✏️ Example: *100*\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
            return;
          }
          if (body === '2') {
            if (SETTINGS.otp_enabled === 'true' && !s.otpVerified) {
              s.temp = { afterOtp: 'DATA_PKGS' }; s.step = 'OTP_GET_PHONE';
              await msg.reply(OTP_MSG);
              return;
            }
            s.step = 'DATA_PKGS'; s.temp = { serviceType: 'data' };
            const okD = await sendPkgList('data');
            if(!okD) s.step = 'AWAITING_MENU';
            return;
          }
          if (body === '3') {
            if (SETTINGS.otp_enabled === 'true' && !s.otpVerified) {
              s.temp = { afterOtp: 'SMS_PKGS' }; s.step = 'OTP_GET_PHONE';
              await msg.reply(OTP_MSG);
              return;
            }
            s.step = 'SMS_PKGS'; s.temp = { serviceType: 'sms' };
            const okS = await sendPkgList('sms');
            if(!okS) s.step = 'AWAITING_MENU';
            return;
          }
          if (body === '4') {
            if (SETTINGS.otp_enabled === 'true' && !s.otpVerified) {
              s.temp = { afterOtp: 'MINS_PKGS' }; s.step = 'OTP_GET_PHONE';
              await msg.reply(OTP_MSG);
              return;
            }
            s.step = 'MINS_PKGS'; s.temp = { serviceType: 'mins' };
            const okM = await sendPkgList('mins');
            if(!okM) s.step = 'AWAITING_MENU';
            return;
          }
          if (body === '5') {
            s.step = 'CHECK_ORDER'; s.temp = {};
            const pfx = SETTINGS.order_prefix || 'KS-';
            await msg.reply(`📦 *Order Tracking*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nEnter your order number to check its status:\n\n✏️ Example: *${pfx}12345678*\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
            return;
          }
          if (body === '6') {
            const contactLine = currentAdminNumber ? `📱 WhatsApp us: *+${currentAdminNumber}*` : '📧 Contact your administrator';
            const helpMsg = `❓ *Help & Support*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${contactLine}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💸 *How to Buy Airtime*\n1️⃣ Select *Buy Airtime* from the menu\n2️⃣ Enter the amount in KES\n3️⃣ Enter the recipient number\n4️⃣ Enter your M-Pesa number\n5️⃣ Complete the M-Pesa STK prompt\n⚡ Airtime is delivered instantly!\n\n📶 *How to Buy Data / SMS / Minutes*\nChoose a service › Pick a package › Follow the steps\n\n📦 *Track an Order*\nSelect *Track My Order* and enter your order number\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Type *00* to return to the main menu_`;
            await msg.reply(helpMsg);
            s.step = 'AWAITING_MENU';
            return;
          }
          if (body === '9' && fromPhone === currentAdminNumber) {
            await msg.reply(`👑 *Admin Panel*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n┃ *1* › 📋 All Orders\n┃ *2* › ✅ Paid Orders\n┃ *3* › ⏳ Pending Orders\n┃ *4* › ❌ Failed Orders\n┃ *5* › 🔍 Check Specific Order\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_0 ‹ Main Menu_`);
            s.step = 'ADMIN_MENU'; s.temp = {};
            return;
          }
          // Invalid option — resend menu
          await msg.reply(`❌ Hmm, that option isn't on the menu.\nPlease choose a number from the list below 👇`);
          await sendMainMenu();
          return;
        }

        case 'BUY_AMOUNT': {
          if (body === '0' || body === '00') { s.step = 'MENU'; s.temp = {}; await sendMainMenu(); return; }
          const amt = parseFloat(body.replace(/[^0-9.]/g, ''));
          const minA = parseFloat(SETTINGS.min_amount || '1');
          const maxA = parseFloat(SETTINGS.max_amount || '1500');
          if (!amt || isNaN(amt) || amt <= 0) {
            await msg.reply(`❌ Please enter a valid amount.\n\n✏️ Example: *100*\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
            return;
          }
          if (amt < minA || amt > maxA) {
            await msg.reply(`❌ Amount must be between *KES ${minA}* and *KES ${maxA}*.\n\nPlease try again:\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
            return;
          }
          s.temp.amount = amt;
          s.step = 'BUY_RECIPIENT';
          await msg.reply(`✅ Amount: *KES ${amt.toFixed(2)}*\n\n📱 *Recipient Number*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nWho should receive the airtime?\nEnter the phone number:\n\n_Format: 07XXXXXXXX or 254XXXXXXXXX_\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
          return;
        }

        case 'BUY_FOR': {
          s.step = 'BUY_RECIPIENT';
          await msg.reply(`📱 *Recipient Number*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nWho should receive the airtime?\nEnter the phone number:\n\n_Format: 07XXXXXXXX or 254XXXXXXXXX_\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
          return;
        }

        case 'BUY_RECIPIENT': {
          if (body === '0') { s.step = 'BUY_AMOUNT'; await msg.reply(`💸 *Buy Airtime*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHow much airtime would you like to buy?\n\n💰 Enter amount in *KES*:\n_Min: KES ${SETTINGS.min_amount||'1'}  •  Max: KES ${SETTINGS.max_amount||'1500'}_\n\n✏️ Example: *100*\n\n_0 ‹ Back  •  00 ‹ Main Menu_`); return; }
          if (body === '00') { s.step = 'MENU'; s.temp = {}; await sendMainMenu(); return; }
          const recB = normalizePhone(body);
          if (!/^254[0-9]{9}$/.test(recB)) {
            await msg.reply(`❌ Invalid phone number.\n\nPlease enter a valid Kenyan number:\n_Format: 07XXXXXXXX or 254XXXXXXXXX_\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
            return;
          }
          s.temp.recipient = recB;
          s.step = 'BUY_PAYER';
          await msg.reply(`✅ Recipient: *+${recB}*\n\n💳 *M-Pesa Payment Number*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nEnter the number you'll use to *pay via M-Pesa*:\n\n_Format: 07XXXXXXXX or 254XXXXXXXXX_\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
          return;
        }

        case 'BUY_PAYER': {
          if (body === '0') { s.step = 'BUY_RECIPIENT'; await msg.reply(`✅ Amount: *KES ${(s.temp.amount||0).toFixed(2)}*\n\n📱 *Recipient Number*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nWho should receive the airtime?\nEnter the phone number:\n\n_Format: 07XXXXXXXX or 254XXXXXXXXX_\n\n_0 ‹ Back  •  00 ‹ Main Menu_`); return; }
          if (body === '00') { s.step = 'MENU'; s.temp = {}; await sendMainMenu(); return; }
          let payerB = /^default$/i.test(body) ? fromPhone : normalizePhone(body);
          if (!/^254[0-9]{9}$/.test(payerB)) {
            await msg.reply(`❌ Invalid phone number.\n\nPlease enter a valid Kenyan number:\n_Format: 07XXXXXXXX or 254XXXXXXXXX_\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
            return;
          }
          s.temp.payer = payerB;
          s.step = 'BUY_CONFIRM';
          const discB = parseFloat(SETTINGS.discount_percent || '0');
          const payableB = s.temp.amount - (s.temp.amount * discB / 100);
          await msg.reply(buildAirtimeConfirm(s.temp.payer, s.temp.recipient, s.temp.amount, payableB, discB));
          return;
        }

        case 'BUY_CONFIRM': {
          if (body === '0' || body === '2') { await msg.reply(`🚫 Order cancelled.\n\n_Type *00* to return to the main menu._`); s.step = 'MENU'; s.temp = {}; return; }
          if (body === '00') { s.step = 'MENU'; s.temp = {}; await sendMainMenu(); return; }
          if (body !== '1') { await msg.reply(`❌ Please reply *1* to confirm or *2* to cancel.\n\n_0 ‹ Cancel  •  00 ‹ Main Menu_`); return; }
          try {
            const amount = parseFloat(s.temp.amount || 0);
            const minC = parseFloat(SETTINGS.min_amount || '1');
            const maxC = parseFloat(SETTINGS.max_amount || '1500');
            if (!amount || amount < minC || amount > maxC) { await msg.reply(`❌ Invalid amount. Please start over.\n\n00 ← Main Menu`); s.step='MENU'; s.temp={}; return; }
            const payer = normalizePhone(s.temp.payer);
            const recipient = normalizePhone(s.temp.recipient);
            if (!/^254[0-9]{9}$/.test(payer) || !/^254[0-9]{9}$/.test(recipient)) { await msg.reply(`❌ Invalid phone numbers. Please start over.\n\n00 ← Main Menu`); s.step='MENU'; s.temp={}; return; }
            const order = createOrder(payer, recipient, amount, SETTINGS.discount_percent||'0', clientId, 'airtime', null, from);
            const sres = await shadowInitiate(clientData.shadowApiKey||SETTINGS.shadow_api_key, clientData.shadowApiSecret||SETTINGS.shadow_api_secret, getShadowAccountId(clientData,'airtime'), payer, order.amount_payable, order.order_no, `Airtime ${order.order_no}`);
            if (!sres || !sres.success) {
              updateOrderByNo(order.order_no, { status: 'failed_payment_init' });
              await msg.reply(`❌ *Could not initiate payment.*\n\n${sres?.message||'Please try again later.'}\n\n00 ← Main Menu`);
              s.step='MENU'; s.temp={}; return;
            }
            updateOrderByNo(order.order_no, { checkout_request_id: sres.checkout_request_id||null, merchant_request_id: sres.merchant_request_id||null });
            await msg.reply(buildStkSentMsg(order));
            await alertAdmin(`🔔 *New Airtime Order*\n📦 ${order.order_no}\n💰 KES ${amount}\n📲 +${payer}`);
            s.step='MENU'; s.temp={};
            (async () => {
              const userJid = from;
              const { paid, tx } = await pollPayment(sres.checkout_request_id, order.order_no, parseInt(SETTINGS.payment_poll_seconds||POLL_SECONDS,10), clientId);
              if (paid) {
                await notifyUser(clientId, userJid, buildPaymentSuccessMsg(order, recipient, tx, clientData));
                await alertAdmin(`✅ Airtime payment confirmed: ${order.order_no}`);
                const dres = await deliverAirtime(order.order_no, clientId);
                if (dres.success) {
                  await notifyUser(clientId, userJid, buildAirtimeDeliveredMsg(order, recipient, tx, clientData));
                  await alertAdmin(`✅ Airtime delivered: ${order.order_no}`);
                } else {
                  await notifyUser(clientId, userJid, buildDeliveryFailedMsg(order, recipient, clientData));
                  await alertAdmin(`⚠️ Airtime delivery failed: ${order.order_no}`);
                }
              } else {
                const ord = findOrder(order.order_no);
                if (ord && ord.status === 'payment_failed') {
                  await notifyUser(clientId, userJid, buildPaymentFailedMsg(order));
                  updateOrderByNo(order.order_no, { status:'payment_failed' });
                  await alertAdmin(`❌ Payment failed: ${order.order_no}`);
                } else if (ord && ord.status !== 'paid') {
                  await notifyUser(clientId, userJid, buildPaymentTimeoutMsg(order));
                  updateOrderByNo(order.order_no, { status:'payment_timeout' });
                  await alertAdmin(`⏰ Payment timeout: ${order.order_no}`);
                }
              }
            })();
          } catch(e) {
            console.error('BUY_CONFIRM error:', e);
            await msg.reply(`❌ An error occurred. Please try again.\n\n00 ← Main Menu`);
            s.step='MENU'; s.temp={};
          }
          return;
        }

        case 'CHECK_ORDER': {
          if (body === '0' || body === '00') { s.step='MENU'; s.temp={}; await sendMainMenu(); return; }
          const orderNo = body.trim().toUpperCase();
          if (!orderNo) { await msg.reply(`❌ Please enter your order number.\n\n✏️ Example: *${SETTINGS.order_prefix||'KS-'}12345678*\n\n_0 ‹ Back  •  00 ‹ Main Menu_`); return; }
          try {
            const ord = findOrder(orderNo);
            if (ord && ord.client_id === clientId) {
              await msg.reply(prettyOrder(ord));
            } else {
              await msg.reply(`❌ Order not found.\n\nPlease double-check the number and try again.\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
              return;
            }
          } catch(e) {
            await msg.reply(`❌ Error retrieving order. Please try again.\n\n_0 ‹ Back  •  00 ‹ Main Menu_`);
            return;
          }
          s.step='MENU'; s.temp={};
          return;
        }

        case 'OTP_GET_PHONE': {
          if (body === '0' || body === '00') { s.step='MENU'; s.temp={}; await sendMainMenu(); return; }
          const otpPhone = normalizePhone(body);
          if (!/^254[0-9]{9}$/.test(otpPhone)) {
            await msg.reply(`❌ Invalid number. Please enter a valid Kenyan number.\n\n✍️ Format: 07XXXXXXXX or 254XXXXXXXXX\n\n0 ← Cancel  |  00 ← Main Menu`);
            return;
          }
          s.temp.otpPhone = otpPhone;
          await msg.reply(`⏳ Sending verification code to *+${otpPhone}*... Please wait.`);
          const sr = await sendOtp(otpPhone);
          if (sr && sr.success !== false) {
            s.step = 'OTP_VERIFY';
            await msg.reply(`✅ Code sent to *+${otpPhone}*!\n\nEnter the *6-digit code* you received:\n\n0 ← Cancel  |  00 ← Main Menu`);
          } else {
            await msg.reply(`⚠️ Could not send OTP: ${sr?.message || 'Please try again.'}\n\n00 ← Main Menu`);
            s.step='MENU'; s.temp={};
          }
          return;
        }

        case 'OTP_VERIFY': {
          if (body === '0' || body === '00') { s.step='MENU'; s.temp={}; await msg.reply(`Verification cancelled.\n\n00 ← Main Menu`); return; }
          const code = body.trim().replace(/\D/g,'');
          if (!code || code.length < 4) { await msg.reply(`❌ Please enter the *6-digit code* you received.\n\n0 ← Cancel`); return; }
          await msg.reply(`⏳ Verifying...`);
          const otpTarget = s.temp.otpPhone || fromPhone;
          const vres = await verifyOtp(otpTarget, code);
          if (vres && (vres.success===true || vres.verified===true || vres.status==='verified')) {
            s.otpVerified = true;
            const next = s.temp?.afterOtp || 'MENU';
            s.temp = {};
            await msg.reply(`✅ *Verified!* Proceeding with your request...`);
            if (next === 'BUY_AMOUNT') {
              s.step = 'BUY_AMOUNT';
              await msg.reply(`💰 *AIRTIME PURCHASE*\n\nEnter the amount in *KES*:\n\n📊 Min: KES ${SETTINGS.min_amount||'1'}  |  Max: KES ${SETTINGS.max_amount||'1500'}\n\n✍️ Example: *100*\n\n0 ← Back  |  00 ← Main Menu`);
            } else if (next === 'DATA_PKGS') { s.step='DATA_PKGS'; s.temp={serviceType:'data'}; await sendPkgList('data');
            } else if (next === 'SMS_PKGS')  { s.step='SMS_PKGS';  s.temp={serviceType:'sms'};  await sendPkgList('sms');
            } else if (next === 'MINS_PKGS') { s.step='MINS_PKGS'; s.temp={serviceType:'mins'}; await sendPkgList('mins');
            } else { s.step='MENU'; await sendMainMenu(); }
          } else {
            await msg.reply(`❌ Incorrect code. Please check your SMS and try again.\n\n0 ← Cancel`);
          }
          return;
        }

        case 'DATA_PKGS':
        case 'SMS_PKGS':
        case 'MINS_PKGS': {
          const svcType = s.temp.serviceType || (s.step==='DATA_PKGS'?'data':s.step==='SMS_PKGS'?'sms':'mins');
          if (body === '0' || body === '00') { s.step='MENU'; s.temp={}; await sendMainMenu(); return; }
          const pkgList = PACKAGES[svcType] || [];
          const idx = parseInt(body,10) - 1;
          if (isNaN(idx) || idx < 0 || idx >= pkgList.length) {
            await msg.reply(`❌ Please enter a number between *1* and *${pkgList.length}*.\n\n0 ← Back  |  00 ← Main Menu`);
            await sendPkgList(svcType);
            return;
          }
          const chosen = pkgList[idx];
          s.temp.package = chosen; s.temp.serviceType = svcType;
          s.step = 'PKG_RECIPIENT';
          await msg.reply(`✅ *${chosen.name}* — KES ${chosen.price}\n\n📱 *RECIPIENT NUMBER*\n\nEnter the number to *receive this bundle*:\n\n✍️ Format: 07XXXXXXXX or 254XXXXXXXXX\n\n0 ← Back  |  00 ← Main Menu`);
          return;
        }

        case 'PKG_FOR': {
          s.step = 'PKG_RECIPIENT';
          await msg.reply(`📱 *RECIPIENT NUMBER*\n\nEnter the number to *receive this bundle*:\n\n✍️ Format: 07XXXXXXXX or 254XXXXXXXXX\n\n0 ← Back  |  00 ← Main Menu`);
          return;
        }

        case 'PKG_RECIPIENT': {
          const pTypeR = s.temp.serviceType || 'data';
          if (body === '0') { s.step = pTypeR==='data'?'DATA_PKGS':pTypeR==='sms'?'SMS_PKGS':'MINS_PKGS'; await sendPkgList(pTypeR); return; }
          if (body === '00') { s.step='MENU'; s.temp={}; await sendMainMenu(); return; }
          const pkgRec = normalizePhone(body);
          if (!/^254[0-9]{9}$/.test(pkgRec)) {
            await msg.reply(`❌ Invalid phone number. Please enter a valid Kenyan number.\n\n✍️ Format: 07XXXXXXXX or 254XXXXXXXXX\n\n0 ← Back  |  00 ← Main Menu`);
            return;
          }
          const pkgForRec = s.temp.package;
          const netsRec = pkgForRec?.networks || ['any'];
          const recipNetRec = detectNetwork(pkgRec);
          if (!netsRec.includes('any') && !netsRec.includes(recipNetRec)) {
            await msg.reply(`❌ Sorry, that number is not eligible for this package. Please enter a different number.\n\n0 ← Try Again  |  00 ← Main Menu`);
            return;
          }
          if (pkgForRec?.once_per_day) {
            const odRec = checkDailyLimit(pkgRec);
            if (odRec && odRec.length > 0) {
              const prevR = odRec[0];
              await msg.reply(`⚠️ *Purchase Not Available*\n\nThe number *+${pkgRec}* has already received *${prevR.packageName}* today.\n\nPlease try again after midnight or use a different number.\n\n0 ← Try Again  |  00 ← Main Menu`);
              return;
            }
          }
          s.temp.recipient = pkgRec;
          s.step = 'PKG_PAYER';
          await msg.reply(`📱 Recipient: *+${pkgRec}*\n\n💳 *M-PESA PAYMENT NUMBER*\n\nEnter the number to *pay with M-Pesa*:\n\n✍️ Format: 07XXXXXXXX or 254XXXXXXXXX\n\n0 ← Back  |  00 ← Main Menu`);
          return;
        }

        case 'PKG_PAYER': {
          if (body === '0') { s.step='PKG_RECIPIENT'; await msg.reply(`✅ *${s.temp.package?.name}* — KES ${s.temp.package?.price}\n\n📱 *RECIPIENT NUMBER*\n\nEnter the number to *receive this bundle*:\n\n✍️ Format: 07XXXXXXXX or 254XXXXXXXXX\n\n0 ← Back  |  00 ← Main Menu`); return; }
          if (body === '00') { s.step='MENU'; s.temp={}; await sendMainMenu(); return; }
          let pkgPayerV = /^default$/i.test(body) ? fromPhone : normalizePhone(body);
          if (!/^254[0-9]{9}$/.test(pkgPayerV)) {
            await msg.reply(`❌ Invalid phone number. Please enter a valid Kenyan number.\n\n✍️ Format: 07XXXXXXXX or 254XXXXXXXXX\n\n0 ← Back  |  00 ← Main Menu`);
            return;
          }
          s.temp.payer = pkgPayerV;
          s.step = 'PKG_CONFIRM';
          const discSelf = parseFloat(SETTINGS.discount_percent||'0');
          const pkgSelf = s.temp.package;
          const payableSelf = pkgSelf.price - (pkgSelf.price * discSelf / 100);
          await msg.reply(buildPkgConfirm(pkgSelf, pkgPayerV, s.temp.recipient, discSelf, payableSelf));
          return;
        }

        case 'PKG_CONFIRM': {
          if (body === '0' || body === '2') { await msg.reply(`Order cancelled.\n\n00 ← Main Menu`); s.step='MENU'; s.temp={}; return; }
          if (body === '00') { s.step='MENU'; s.temp={}; await sendMainMenu(); return; }
          if (body !== '1') { await msg.reply(`❌ Please reply *1* to confirm or *2* to cancel.\n\n0 ← Cancel  |  00 ← Main Menu`); return; }
          try {
            const pkg = s.temp.package;
            const svcType = s.temp.serviceType;
            const payer = normalizePhone(s.temp.payer);
            const recipient = normalizePhone(s.temp.recipient);
            if (!pkg || !payer || !recipient) { await msg.reply(`❌ Session expired. Please start over.\n\n00 ← Main Menu`); s.step='MENU'; s.temp={}; return; }
            const order = createOrder(payer, recipient, pkg.price, SETTINGS.discount_percent||'0', clientId, svcType, pkg.id, from);
            const accountId = getShadowAccountId(clientData, svcType);
            const svcLabel = svcType==='data'?'Data Bundle':svcType==='sms'?'SMS Package':'Minutes Bundle';
            const sres = await shadowInitiate(clientData.shadowApiKey||SETTINGS.shadow_api_key, clientData.shadowApiSecret||SETTINGS.shadow_api_secret, accountId, payer, order.amount_payable, order.order_no, `${svcLabel}: ${pkg.name}`);
            if (!sres || !sres.success) {
              updateOrderByNo(order.order_no, { status:'failed_payment_init' });
              await msg.reply(`❌ *Could not initiate payment.*\n\n${sres?.message||'Please try again later.'}\n\n00 ← Main Menu`);
              s.step='MENU'; s.temp={}; return;
            }
            updateOrderByNo(order.order_no, { checkout_request_id: sres.checkout_request_id||null, merchant_request_id: sres.merchant_request_id||null });
            await msg.reply(buildStkSentMsg(order));
            await alertAdmin(`🔔 *New ${svcLabel} Order*\n📦 ${order.order_no}\n💰 KES ${pkg.price}\n📶 ${pkg.name}\n📲 +${payer}`);
            s.step='MENU'; s.temp={};
            (async () => {
              const userJid = from;
              const { paid, tx } = await pollPayment(sres.checkout_request_id, order.order_no, parseInt(SETTINGS.payment_poll_seconds||POLL_SECONDS,10), clientId);
              if (paid) {
                if (pkg.once_per_day) {
                  recordDailyPurchase(recipient, { packageId:pkg.id, packageName:pkg.name, category:svcType, clientId, timestamp:now() });
                }
                const latestOrder = findOrder(order.order_no) || order;
                await notifyUser(clientId, userJid, buildPkgPaymentSuccessMsg(latestOrder, pkg, recipient, tx));
                await alertAdmin(`✅ Payment confirmed: ${order.order_no} — ${pkg.name}`);
                updateOrderByNo(order.order_no, { airtime_status:'bundle_processing' });
                await sendAdminSmsAlert(latestOrder, clientData);
              } else {
                const ord = findOrder(order.order_no);
                if (ord && ord.status === 'payment_failed') {
                  await notifyUser(clientId, userJid, buildPkgPaymentFailedMsg(order, pkg));
                  await alertAdmin(`❌ Payment failed: ${order.order_no}`);
                } else if (ord && ord.status !== 'paid') {
                  await notifyUser(clientId, userJid, buildPkgPaymentTimeoutMsg(order, pkg));
                  updateOrderByNo(order.order_no, { status:'payment_timeout' });
                  await alertAdmin(`⏰ Payment timeout: ${order.order_no}`);
                }
              }
            })();
          } catch(e) {
            console.error('PKG_CONFIRM error:', e);
            await msg.reply(`❌ An error occurred. Please try again.\n\n00 ← Main Menu`);
            s.step='MENU'; s.temp={};
          }
          return;
        }

        default: {
          s.step='MENU'; s.temp={};
          await sendMainMenu();
          return;
        }
      }

    } catch (e) {
      console.error(`[${clientId}] Message handler error`, e);
    }
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[${clientId}] Loading: ${percent}% - ${message}`);
  });

  client.on('remote_session_saved', () => {
    console.log(`[${clientId}] Session saved successfully`);
  });

  const MAX_INIT_RETRIES = 3;

  async function handleInitFailure(error) {
    console.error(`[${clientId}] Client init error (attempt ${clientData.initRetryCount + 1}):`, error.message);
    clientData.status = 'init_failed';
    clientData.initRetryCount++;
    
    if (CLIENTS_DATA[clientId]) {
      CLIENTS_DATA[clientId].initRetryCount = clientData.initRetryCount;
      saveClients();
    }
    
    if (error.message && error.message.includes('profile appears to be in use')) {
      console.log(`[${clientId}] Profile lock detected. Clearing entire session directory...`);
      try {
        await clientData.client.destroy().catch(() => {});
        CLIENTS.delete(clientId);
        
        const sessionPath = path.join(SESSION_DIR, `session-${clientId}`);
        if (fs.existsSync(sessionPath)) {
          console.log(`[${clientId}] Removing locked session directory: ${sessionPath}`);
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
      } catch (cleanupErr) {
        console.error(`[${clientId}] Error during session cleanup:`, cleanupErr.message);
      }
    }
    
    if (clientData.initRetryCount < MAX_INIT_RETRIES) {
      const retryDelay = 10000 + (clientData.initRetryCount * 5000);
      console.log(`[${clientId}] Retry ${clientData.initRetryCount}/${MAX_INIT_RETRIES} in ${retryDelay/1000}s...`);
      setTimeout(async () => {
        if (clientData.status === 'init_failed') {
          if (!CLIENTS.has(clientId)) {
            console.log(`[${clientId}] Recreating client after session cleanup...`);
            createWhatsAppClient(clientId);
          } else {
            try {
              await clientData.client.initialize();
            } catch (err) {
              await handleInitFailure(err);
            }
          }
        }
      }, retryDelay);
    } else {
      console.error(`[${clientId}] Max retries (${MAX_INIT_RETRIES}) exceeded. Manual intervention required.`);
      
      if (CLIENTS_DATA[clientId]) {
        CLIENTS_DATA[clientId].initRetryCount = 0;
        saveClients();
      }
      
      await alertAdmin(`⚠️ *${clientData.botName}* failed to initialize after ${MAX_INIT_RETRIES} attempts. Please reconnect via web interface.`).catch(() => {});
    }
  }

  client.on('ready', () => {
    if (CLIENTS_DATA[clientId] && clientData.initRetryCount > 0) {
      console.log(`[${clientId}] Successfully connected after ${clientData.initRetryCount} retry(ies). Resetting counter.`);
      clientData.initRetryCount = 0;
      CLIENTS_DATA[clientId].initRetryCount = 0;
      saveClients();
    }
  });

  client.initialize().catch(handleInitFailure);

  CLIENTS.set(clientId, clientData);
  return clientData;
}

function disconnectClient(clientId) {
  const clientData = CLIENTS.get(clientId);
  if (!clientData) return false;
  
  try {
    clientData.client.destroy();
    CLIENTS.delete(clientId);
    if (CLIENTS_DATA[clientId]) {
      CLIENTS_DATA[clientId].status = 'disconnected';
      saveClients();
    }
    return true;
  } catch (e) {
    console.error('Error disconnecting client:', e);
    return false;
  }
}

function stopClient(clientId) {
  const clientData = CLIENTS.get(clientId);
  if (!clientData) return false;
  
  try {
    clientData.isPaused = true;
    if (CLIENTS_DATA[clientId]) {
      CLIENTS_DATA[clientId].isPaused = true;
      saveClients();
    }
    return true;
  } catch (e) {
    console.error('Error stopping client:', e);
    return false;
  }
}

function resumeClient(clientId) {
  const clientData = CLIENTS.get(clientId);
  if (!clientData) return false;
  
  try {
    clientData.isPaused = false;
    if (CLIENTS_DATA[clientId]) {
      CLIENTS_DATA[clientId].isPaused = false;
      saveClients();
    }
    return true;
  } catch (e) {
    console.error('Error resuming client:', e);
    return false;
  }
}

// ----- Express + Socket.IO -----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Socket.IO with client rooms
io.on('connection', socket => {
  const clientId = socket.handshake.query.clientId;
  
  if (clientId) {
    socket.join(clientId);
    console.log(`Socket connected for client: ${clientId}`);
    
    const clientData = CLIENTS.get(clientId);
    if (clientData) {
      // Already connected — send status immediately
      if (clientData.status === 'connected' || (clientData.client.info && clientData.client.info.wid)) {
        socket.emit('status', { connected: true, clientId });
      } else if (clientData.lastPairingCode) {
        // Pairing code already generated — re-send it
        socket.emit('pairing_code', { code: clientData.lastPairingCode, clientId, phone: clientData.pairingPhone });
      } else if (clientData.lastQr && clientData.status === 'qr_ready') {
        // QR already generated — re-send it
        qrcode.toDataURL(clientData.lastQr).then(dataUrl => {
          socket.emit('qr', { url: dataUrl, clientId });
        }).catch(e => {
          console.error(`[${clientId}] Error sending QR via socket:`, e);
        });
      }
    }
  }
});

// ----- API routes -----
app.post('/api/verify-access-code', (req, res) => {
  const { accessCode } = req.body;
  const correctCode = SETTINGS.access_code || '4262';
  
  if (accessCode !== correctCode) {
    return res.json({ success: false, message: 'Invalid access code' });
  }
  
  const clientId = 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  if (!CLIENTS_DATA[clientId]) CLIENTS_DATA[clientId] = {};
  CLIENTS_DATA[clientId].loginType = 'qr';
  saveClients();
  createWhatsAppClient(clientId);

  res.json({ success: true, clientId });
});

app.post('/api/request-pairing-code', (req, res) => {
  const { accessCode, phoneNumber } = req.body;
  const correctCode = SETTINGS.access_code || '4262';

  if (accessCode !== correctCode) {
    return res.json({ success: false, message: 'Invalid access code' });
  }

  const phone = normalizePhone(phoneNumber || '');
  if (!/^254[0-9]{9}$/.test(phone)) {
    return res.json({ success: false, message: 'Invalid phone number. Use format: 07XXXXXXXX or 2547XXXXXXXX' });
  }

  const clientId = 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  if (!CLIENTS_DATA[clientId]) CLIENTS_DATA[clientId] = {};
  CLIENTS_DATA[clientId].loginType = 'pairing';
  CLIENTS_DATA[clientId].pairingPhone = phone;
  saveClients();
  createWhatsAppClient(clientId, { pairingPhone: phone });

  res.json({ success: true, clientId, phone });
});

app.post('/api/initiate', async (req, res) => {
  try {
    const clientId = req.body.client_id;
    const amount = parseFloat(req.body.amount || 0);
    const min = parseFloat(SETTINGS.min_amount || '1');
    const max = parseFloat(SETTINGS.max_amount || '1500');
    if (!amount || amount < min || amount > max) return res.json({ success: false, message: `Amount must be between KES ${min} and KES ${max}` });

    const payer_raw = req.body.mpesa_number || req.body.payer_number || '';
    const recipient_raw = req.body.recipient_number || payer_raw;
    const payer = normalizePhone(payer_raw);
    const recipient = normalizePhone(recipient_raw);
    if (!/^254[0-9]{9}$/.test(payer) || !/^254[0-9]{9}$/.test(recipient)) return res.json({ success: false, message: 'Invalid Kenyan phone numbers.' });

    const order = createOrder(payer, recipient, amount, SETTINGS.discount_percent || '0', clientId || 'api');

    const clientData = CLIENTS.get(clientId) || CLIENTS_DATA[clientId];
    const shadowAccountId = clientData?.shadowAccountId || SETTINGS.shadow_account_id;
    const shadowApiKey = clientData?.shadowApiKey || SETTINGS.shadow_api_key;
    const shadowApiSecret = clientData?.shadowApiSecret || SETTINGS.shadow_api_secret;

    const sres = await shadowInitiate(shadowApiKey, shadowApiSecret, shadowAccountId, payer, order.amount_payable, order.order_no, `Airtime payment ${order.order_no}`);
    if (!sres || !sres.success) {
      updateOrderByNo(order.order_no, { status: 'failed_payment_init' });
      return res.json({ success: false, message: `Failed to send STK: ${sres && sres.message ? sres.message : 'Unknown'}`, raw: sres });
    }

    const checkout_request_id = sres.checkout_request_id || null;
    const merchant_request_id = sres.merchant_request_id || null;
    updateOrderByNo(order.order_no, { checkout_request_id, merchant_request_id });

    (async () => {
      const pollTimeout = parseInt(SETTINGS.payment_poll_seconds || POLL_SECONDS, 10);
      const { paid, tx } = await pollPayment(checkout_request_id, order.order_no, pollTimeout, clientId);
      const userJid = toJid(payer);
      
      if (paid) {
        const successMsg = `✅ *PAYMENT CONFIRMED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📦 *Order:*        ${order.order_no}\n💰 *Paid:*          KES ${order.amount_payable.toFixed(2)}\n📲 *Airtime To:* +${recipient}\n🏷️ *M-Pesa Code:* ${tx || 'Processing...'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏳ _Sending your airtime now..._`;
        await notifyUser(clientId, userJid, successMsg);

        const dres = await deliverAirtime(order.order_no, clientId);
        const bn = SETTINGS.bot_name || 'FY Bot';

        if (dres.success) {
          const deliveryMsg = `🎉 *AIRTIME DELIVERED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n✅ *KES ${order.amount.toFixed(2)}* sent to *+${recipient}*\n\n📦 *Order:*        ${order.order_no}\n🏷️ *M-Pesa Code:* ${tx || 'N/A'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nThank you for using *${bn}*! 🙏\n_Type *00* for the main menu._`;
          await notifyUser(clientId, userJid, deliveryMsg);
        } else {
          const adminNum = (CLIENTS.get(clientId) || {})?.adminNumber || SETTINGS.admin_whatsapp || '';
          const contactLine = adminNum ? `\n📱 *Support:* +${adminNum}` : '';
          const failMsg = `⚠️ *DELIVERY ISSUE*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nPayment of *KES ${order.amount_payable.toFixed(2)}* was received, but airtime could not be sent to *+${recipient}* at this time.\n\n📦 *Order:* ${order.order_no}${contactLine}\n\n_Please contact support with your order number and we'll resolve this promptly._`;
          await notifyUser(clientId, userJid, failMsg);
        }
      } else {
        const ord = findOrder(order.order_no);
        if (ord && ord.status === 'payment_failed') {
          const failMsg = `❌ *PAYMENT NOT COMPLETED*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📦 *Order:* ${order.order_no}\n\n*Possible reasons:*\n• Insufficient M-Pesa balance\n• Wrong PIN entered\n• Transaction cancelled\n• Network issue\n\n_Type *00* to return to the menu and try again._`;
          await notifyUser(clientId, userJid, failMsg);
        } else {
          const timeoutMsg = `⏱️ *PAYMENT PENDING*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nWe haven't received confirmation of your payment yet.\n\n📦 *Order:* ${order.order_no}\n\n_If you paid, it may still be processing — enter your order number to check status._\n\n_If you did not pay, type *00* to return to the menu._`;
          await notifyUser(clientId, userJid, timeoutMsg);
        }
      }
    })();

    return res.json({ success: true, message: 'STK push sent', order_no: order.order_no, checkout_request_id, amount_payable: order.amount_payable });
  } catch (e) {
    console.error('initiate error', e);
    return res.json({ success: false, message: e.message });
  }
});

app.post('/api/get_order', (req, res) => {
  try {
    const order_no = req.body.order_no || req.query.order_no;
    if (!order_no) return res.json({ success: false, message: 'Missing order_no' });
    const ord = findOrder(order_no);
    if (!ord) return res.json({ success: false, message: 'Order not found' });
    return res.json({ success: true, order: ord });
  } catch (e) {
    return res.json({ success: false, message: e.message });
  }
});

app.post('/api/check_status', async (req, res) => {
  try {
    const checkout = req.body.checkout_request_id || req.body.checkout;
    if (!checkout) return res.json({ success: false, message: 'Missing checkout_request_id' });
    const sres = await shadowStatus(SETTINGS.shadow_api_key, SETTINGS.shadow_api_secret, checkout);
    const pstatus = (sres.status || sres.result || '').toString().toLowerCase();
    const tx = sres.transaction_code || sres.transaction || null;
    if (pstatus === 'completed' || pstatus === 'success' || tx) { updateOrderByCheckout(checkout, { status: 'paid', transaction_code: tx || null }); return res.json({ success: true, status: 'paid', transaction_code: tx, raw: sres }); }
    if (pstatus === 'failed' || (sres.message && sres.message.toString().toLowerCase() === 'failed')) { updateOrderByCheckout(checkout, { status: 'payment_failed' }); return res.json({ success: true, status: 'payment_failed', raw: sres }); }
    return res.json({ success: true, status: 'pending', raw: sres });
  } catch (e) {
    return res.json({ success: false, message: e.message });
  }
});

app.post('/api/deliver', async (req, res) => {
  try {
    const order_no = req.body.order_no;
    if (!order_no) return res.json({ success: false, message: 'Missing order_no' });
    const ord = findOrder(order_no);
    if (!ord) return res.json({ success: false, message: 'Order not found' });
    if (ord.status !== 'paid') updateOrderByNo(order_no, { status: 'paid' });
    const dres = await deliverAirtime(order_no);
    if (dres.success) return res.json({ success: true, message: 'Airtime delivered', statum: dres.statum });
    return res.json({ success: false, message: 'Delivery failed', statum: dres.statum || dres });
  } catch (e) {
    return res.json({ success: false, message: e.message });
  }
});

// ----- Admin endpoints -----
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token || req.body.token;
  if (token === ADMIN_UI_TOKEN) return next();
  res.status(401).json({ success: false, message: 'Unauthorized' });
}

app.get('/admin/clients', adminAuth, (req, res) => {
  const clientsList = [];
  for (const [id, data] of CLIENTS.entries()) {
    clientsList.push({
      id,
      status: data.status,
      botName: data.botName,
      adminNumber: data.adminNumber,
      connectedNumber: data.connectedNumber,
      createdAt: data.createdAt,
      isPaused: data.isPaused || false,
      bannedUsersCount: Object.keys(data.bannedUsers || {}).length
    });
  }
  res.json({ success: true, clients: clientsList });
});

app.post('/admin/disconnect-client', adminAuth, (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.json({ success: false, message: 'Missing clientId' });
  
  const success = disconnectClient(clientId);
  if (success) {
    return res.json({ success: true, message: 'Client disconnected successfully' });
  }
  return res.json({ success: false, message: 'Failed to disconnect client' });
});

app.post('/admin/update-client', adminAuth, (req, res) => {
  const { clientId, botName, adminNumber, shadowAccountId, shadowApiKey, shadowApiSecret, dataShadowAccountId, smsShadowAccountId, minsShadowAccountId, statumConsumerKey, statumConsumerSecret } = req.body;
  if (!clientId) return res.json({ success: false, message: 'Missing clientId' });
  
  const clientData = CLIENTS.get(clientId);
  if (!clientData) return res.json({ success: false, message: 'Client not found' });
  
  if (botName !== undefined) clientData.botName = botName;
  if (adminNumber !== undefined) clientData.adminNumber = normalizePhone(adminNumber);
  if (shadowAccountId !== undefined) clientData.shadowAccountId = shadowAccountId;
  if (shadowApiKey !== undefined) clientData.shadowApiKey = shadowApiKey;
  if (shadowApiSecret !== undefined) clientData.shadowApiSecret = shadowApiSecret;
  if (dataShadowAccountId !== undefined) clientData.dataShadowAccountId = dataShadowAccountId;
  if (smsShadowAccountId !== undefined) clientData.smsShadowAccountId = smsShadowAccountId;
  if (minsShadowAccountId !== undefined) clientData.minsShadowAccountId = minsShadowAccountId;
  if (statumConsumerKey !== undefined) clientData.statumConsumerKey = statumConsumerKey;
  if (statumConsumerSecret !== undefined) clientData.statumConsumerSecret = statumConsumerSecret;
  
  CLIENTS_DATA[clientId] = {
    ...CLIENTS_DATA[clientId],
    botName: clientData.botName,
    adminNumber: clientData.adminNumber,
    shadowAccountId: clientData.shadowAccountId,
    shadowApiKey: clientData.shadowApiKey,
    shadowApiSecret: clientData.shadowApiSecret,
    dataShadowAccountId: clientData.dataShadowAccountId,
    smsShadowAccountId: clientData.smsShadowAccountId,
    minsShadowAccountId: clientData.minsShadowAccountId,
    statumConsumerKey: clientData.statumConsumerKey,
    statumConsumerSecret: clientData.statumConsumerSecret
  };
  saveClients();
  
  res.json({ success: true, message: 'Client updated successfully' });
});

app.post('/admin/stop-client', adminAuth, (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.json({ success: false, message: 'Missing clientId' });
  
  const success = stopClient(clientId);
  if (success) {
    return res.json({ success: true, message: 'Client stopped successfully' });
  }
  return res.json({ success: false, message: 'Failed to stop client' });
});

app.post('/admin/resume-client', adminAuth, (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.json({ success: false, message: 'Missing clientId' });
  
  const success = resumeClient(clientId);
  if (success) {
    return res.json({ success: true, message: 'Client resumed successfully' });
  }
  return res.json({ success: false, message: 'Failed to resume client' });
});

app.post('/admin/ban-user', adminAuth, (req, res) => {
  const { clientId, phoneNumber, reason } = req.body;
  if (!clientId || !phoneNumber) return res.json({ success: false, message: 'Missing clientId or phoneNumber' });
  
  const clientData = CLIENTS.get(clientId);
  if (!clientData) return res.json({ success: false, message: 'Client not found' });
  
  const normalizedPhone = phoneNumber.replace(/\D/g, '');
  if (!normalizedPhone) return res.json({ success: false, message: 'Invalid phone number' });
  
  clientData.bannedUsers[normalizedPhone] = {
    reason: reason || 'No reason provided',
    bannedAt: now(),
    bannedBy: 'admin'
  };
  
  if (CLIENTS_DATA[clientId]) {
    CLIENTS_DATA[clientId].bannedUsers = clientData.bannedUsers;
    saveClients();
  }
  
  res.json({ success: true, message: 'User banned successfully' });
});

app.post('/admin/unban-user', adminAuth, (req, res) => {
  const { clientId, phoneNumber } = req.body;
  if (!clientId || !phoneNumber) return res.json({ success: false, message: 'Missing clientId or phoneNumber' });
  
  const clientData = CLIENTS.get(clientId);
  if (!clientData) return res.json({ success: false, message: 'Client not found' });
  
  const normalizedPhone = phoneNumber.replace(/\D/g, '');
  if (!normalizedPhone) return res.json({ success: false, message: 'Invalid phone number' });
  
  delete clientData.bannedUsers[normalizedPhone];
  
  if (CLIENTS_DATA[clientId]) {
    CLIENTS_DATA[clientId].bannedUsers = clientData.bannedUsers;
    saveClients();
  }
  
  res.json({ success: true, message: 'User unbanned successfully' });
});

app.get('/admin/client/:clientId', adminAuth, (req, res) => {
  const clientId = req.params.clientId;
  const clientData = CLIENTS.get(clientId);
  
  if (!clientData) {
    return res.json({ success: false, message: 'Client not found' });
  }
  
  const bannedUsersList = Object.keys(clientData.bannedUsers || {}).map(phone => ({
    phone: '+' + phone,
    ...clientData.bannedUsers[phone]
  }));
  
  res.json({
    success: true,
    client: {
      id: clientData.id,
      botName: clientData.botName,
      adminNumber: clientData.adminNumber,
      shadowAccountId: clientData.shadowAccountId,
      shadowApiKey: clientData.shadowApiKey,
      shadowApiSecret: clientData.shadowApiSecret,
      dataShadowAccountId: clientData.dataShadowAccountId,
      smsShadowAccountId: clientData.smsShadowAccountId,
      minsShadowAccountId: clientData.minsShadowAccountId,
      statumConsumerKey: clientData.statumConsumerKey,
      statumConsumerSecret: clientData.statumConsumerSecret,
      status: clientData.status,
      isPaused: clientData.isPaused,
      connectedNumber: clientData.connectedNumber,
      createdAt: clientData.createdAt,
      bannedUsers: bannedUsersList
    }
  });
});

app.get('/admin/orders', adminAuth, (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const q = (req.query.q || '').toLowerCase();
    let list = ORDERS.slice();
    if (filter === 'paid') list = list.filter(x => x.status === 'paid');
    else if (filter === 'pending') list = list.filter(x => x.status && x.status.indexOf('pending') !== -1);
    else if (filter === 'cancelled') list = list.filter(x => ['payment_failed', 'delivery_failed', 'failed_payment_init', 'payment_timeout'].includes(x.status));
    if (q) list = list.filter(o => (o.order_no || '').toLowerCase().includes(q) || (o.transaction_code || '').toLowerCase().includes(q) || (o.payer_number || '').toLowerCase().includes(q));
    res.json({ success: true, orders: list.slice(0, 1000) });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/admin/order/:order_no', adminAuth, (req, res) => {
  const ord = findOrder(req.params.order_no);
  if (!ord) return res.json({ success: false, message: 'Not found' });
  res.json({ success: true, order: ord });
});

app.post('/admin/update-order-status', adminAuth, async (req, res) => {
  try {
    const { order_no, admin_status, admin_remark } = req.body;
    if (!order_no) return res.json({ success: false, message: 'order_no required' });
    const ord = findOrder(order_no);
    if (!ord) return res.json({ success: false, message: 'Order not found' });
    if (!['data','sms','mins'].includes(ord.order_type)) return res.json({ success: false, message: 'Status update only available for data/sms/mins orders' });
    const prevAdminStatus = ord.admin_status;
    if (admin_status !== undefined) ord.admin_status = String(admin_status).trim();
    if (admin_remark !== undefined) ord.admin_remark = String(admin_remark).trim();
    ord.updated_at = now();
    saveOrders();

    // Notify user on WhatsApp if admin_status changed
    if (admin_status !== undefined && String(admin_status).trim() !== prevAdminStatus) {
      try {
        const typeMap = { data:'📶 Data Bundle', sms:'💬 SMS Package', mins:'⏱️ Minutes Bundle' };
        const pkgList = PACKAGES[ord.order_type] || [];
        const pkg = ord.package_id ? pkgList.find(p => p.id === ord.package_id) : null;
        const pkgLine = pkg ? `\n📦 *Package:*    ${pkg.name}` : '';
        const remarkLine = ord.admin_remark ? `\n💬 *Note:*       ${ord.admin_remark}` : '';
        const notifMsg =
`🔔 *ORDER UPDATE*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 *Order:*      ${ord.order_no}
🛒 *Service:*   ${typeMap[ord.order_type] || ord.order_type}${pkgLine}
📱 *Recipient:* +${ord.recipient_number}
💸 *Amount:*    KES ${parseFloat(ord.amount_payable).toFixed(2)}

✏️ *Status:*    ${ord.admin_status}${remarkLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Type *${ord.order_no}* to check full details_`;
        const userJid = ord.sender_jid || toJid(ord.payer_number);
        if (userJid) await notifyUser(ord.client_id, userJid, notifMsg).catch(() => {});
      } catch(ne){ console.error('notify error on order update:', ne.message); }
    }

    res.json({ success: true, message: 'Order updated', order: ord });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/admin/settings', adminAuth, (req, res) => {
  res.json({ success: true, settings: SETTINGS });
});

app.get('/api/app-info', (req, res) => {
  res.json({ success: true, appName: SETTINGS.app_name || 'FY Bot', footerText: SETTINGS.footer_text || 'Powered by whatsapp-web.js • FY Bot System' });
});

app.post('/admin/settings', adminAuth, (req, res) => {
  try {
    Object.keys(req.body || {}).forEach(k => {
      SETTINGS[k] = String(req.body[k] ?? '');
    });
    saveSettings();
    res.json({ success: true, message: 'Settings saved successfully!' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/admin/system-info', adminAuth, (req, res) => {
  try {
    const info = {
      platform: process.platform,
      nodeVersion: process.version,
      totalOrders: ORDERS.length,
      totalClients: CLIENTS.size,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
    res.json({ success: true, info });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/admin/restart-client', adminAuth, async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.json({ success: false, message: 'Missing clientId' });
  
  try {
    const clientData = CLIENTS.get(clientId);
    if (!clientData) return res.json({ success: false, message: 'Client not found' });
    
    console.log(`[${clientId}] Manual restart requested by admin`);
    
    await clientData.client.destroy();
    CLIENTS.delete(clientId);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`[${clientId}] Recreating client after manual restart...`);
    createWhatsAppClient(clientId);
    
    res.json({ success: true, message: 'Client restart initiated. Please wait for QR code or reconnection.' });
  } catch (e) {
    console.error(`[${clientId}] Error during manual restart:`, e.message);
    res.json({ success: false, message: `Restart failed: ${e.message}` });
  }
});

app.post('/admin/bulk-message', adminAuth, async (req, res) => {
  const { clientId, message, imageUrl, recipients } = req.body;
  
  if (!clientId) return res.json({ success: false, message: 'Missing clientId' });
  if (!message && !imageUrl) return res.json({ success: false, message: 'Message or image required' });
  
  try {
    const clientData = CLIENTS.get(clientId);
    if (!clientData) return res.json({ success: false, message: 'Client not found' });
    
    if (!clientData.client || clientData.status !== 'connected') {
      return res.json({ success: false, message: 'Client not connected' });
    }
    
    let targetNumbers = [];
    
    if (recipients === 'all_connected') {
      const uniqueNumbers = new Set();
      ORDERS.filter(o => o.client_id === clientId).forEach(order => {
        uniqueNumbers.add(order.payer_number);
        if (order.recipient_number !== order.payer_number) {
          uniqueNumbers.add(order.recipient_number);
        }
      });
      targetNumbers = Array.from(uniqueNumbers);
    } else if (Array.isArray(recipients)) {
      targetNumbers = recipients.map(normalizePhone).filter(n => /^254[0-9]{9}$/.test(n));
    } else {
      return res.json({ success: false, message: 'Invalid recipients format' });
    }
    
    if (targetNumbers.length === 0) {
      return res.json({ success: false, message: 'No valid recipients found' });
    }
    
    console.log(`[${clientId}] Bulk message to ${targetNumbers.length} recipients`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (const phone of targetNumbers) {
      try {
        const jid = toJid(phone);
        
        if (imageUrl) {
          const media = await MessageMedia.fromUrl(imageUrl);
          await clientData.client.sendMessage(jid, media, { caption: message || '' });
        } else {
          await clientData.client.sendMessage(jid, message);
        }
        
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) {
        console.error(`[${clientId}] Bulk message failed for ${phone}:`, e.message);
        failCount++;
      }
    }
    
    res.json({ 
      success: true, 
      message: `Bulk message sent!`,
      total: targetNumbers.length,
      success: successCount,
      failed: failCount
    });
  } catch (e) {
    console.error(`[${clientId}] Bulk message error:`, e.message);
    res.json({ success: false, message: e.message });
  }
});

// ----- Package Admin Endpoints -----
app.get('/admin/packages', adminAuth, (req, res) => {
  res.json({ success: true, packages: PACKAGES });
});

app.post('/admin/add-package', adminAuth, (req, res) => {
  const { category, name, price, description, networks, once_per_day } = req.body;
  if(!category || !['data','sms','mins'].includes(category)) return res.json({ success:false, message:'Invalid category. Must be data, sms, or mins.' });
  if(!name || !price) return res.json({ success:false, message:'Name and price are required.' });
  const pkg = {
    id: uuidv4(),
    name: String(name).trim(),
    price: parseFloat(price),
    description: String(description || '').trim(),
    networks: Array.isArray(networks) ? networks : (networks ? String(networks).split(',').map(n=>n.trim().toLowerCase()) : ['any']),
    once_per_day: once_per_day === true || once_per_day === 'true',
    createdAt: now()
  };
  if(!PACKAGES[category]) PACKAGES[category] = [];
  PACKAGES[category].push(pkg);
  savePackages();
  res.json({ success:true, message:'Package added successfully.', package: pkg });
});

app.post('/admin/update-package', adminAuth, (req, res) => {
  const { category, id, name, price, description, networks, once_per_day } = req.body;
  if(!category || !id) return res.json({ success:false, message:'Category and id are required.' });
  const list = PACKAGES[category] || [];
  const idx = list.findIndex(p=>p.id===id);
  if(idx === -1) return res.json({ success:false, message:'Package not found.' });
  if(name !== undefined) list[idx].name = String(name).trim();
  if(price !== undefined) list[idx].price = parseFloat(price);
  if(description !== undefined) list[idx].description = String(description).trim();
  if(networks !== undefined) list[idx].networks = Array.isArray(networks) ? networks : String(networks).split(',').map(n=>n.trim().toLowerCase());
  if(once_per_day !== undefined) list[idx].once_per_day = once_per_day === true || once_per_day === 'true';
  list[idx].updatedAt = now();
  PACKAGES[category] = list;
  savePackages();
  res.json({ success:true, message:'Package updated.', package: list[idx] });
});

app.post('/admin/delete-package', adminAuth, (req, res) => {
  const { category, id } = req.body;
  if(!category || !id) return res.json({ success:false, message:'Category and id are required.' });
  const before = (PACKAGES[category]||[]).length;
  PACKAGES[category] = (PACKAGES[category]||[]).filter(p=>p.id!==id);
  if(PACKAGES[category].length === before) return res.json({ success:false, message:'Package not found.' });
  savePackages();
  res.json({ success:true, message:'Package deleted.' });
});

app.get('/admin', (req, res) => {
  if (req.query.token !== ADMIN_UI_TOKEN) return res.status(401).send('Unauthorized. Provide ?token=ADMIN_UI_TOKEN');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/health', (req, res) => {
  const clientsInfo = Array.from(CLIENTS.values()).map(c => ({
    id: c.id,
    status: c.status
  }));
  
  res.json({ 
    ok: true,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    clients: CLIENTS.size,
    connected: clientsInfo.filter(c => c.status === 'connected').length,
    disconnected: clientsInfo.filter(c => c.status === 'disconnected').length,
    timestamp: new Date().toISOString()
  });
});

// Clean up stale Chromium lock files
function cleanupStaleLocks() {
  console.log('Cleaning up stale Chromium lock files...');
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      return;
    }
    
    const sessionDirs = fs.readdirSync(SESSION_DIR);
    let cleaned = 0;
    
    sessionDirs.forEach(dir => {
      const sessionPath = path.join(SESSION_DIR, dir);
      if (fs.statSync(sessionPath).isDirectory()) {
        const singletonLock = path.join(sessionPath, 'Default', 'SingletonLock');
        if (fs.existsSync(singletonLock)) {
          try {
            fs.unlinkSync(singletonLock);
            cleaned++;
            console.log(`Removed lock file: ${singletonLock}`);
          } catch (e) {
            console.error(`Failed to remove lock: ${singletonLock}`, e.message);
          }
        }
      }
    });
    
    console.log(`Cleaned ${cleaned} stale lock file(s)`);
  } catch (e) {
    console.error('Error cleaning up locks:', e.message);
  }
}

// Auto-initialize saved clients on startup — max 3 at a time to avoid resource starvation
function initializeSavedClients() {
  console.log('Checking for saved clients to auto-initialize...');
  const savedClients = Object.keys(CLIENTS_DATA);

  if (savedClients.length === 0) {
    console.log('No saved clients found.');
    return;
  }

  console.log(`Found ${savedClients.length} saved client(s). Initializing max 3 at a time (20s slots)...`);

  const MAX_CONCURRENT = 3;
  let index = 0;
  let active = 0;

  function startNext() {
    while (active < MAX_CONCURRENT && index < savedClients.length) {
      const clientId = savedClients[index];
      const num = index + 1;
      index++;
      active++;
      try {
        console.log(`[${clientId}] Auto-initializing from saved data (${num}/${savedClients.length})...`);
        createWhatsAppClient(clientId);
      } catch(e) {
        console.error(`[${clientId}] Error auto-initializing:`, e.message);
      }
      // Release slot after 20s so the next batch can begin
      setTimeout(() => { active--; startNext(); }, 20000);
    }
  }

  startNext();
  console.log(`Queue started — max ${MAX_CONCURRENT} concurrent browser launches`);
}

// Keep-alive mechanism to prevent dyno sleeping
function setupKeepAlive() {
  const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000;
  const SELF_PING_INTERVAL = 25 * 60 * 1000;
  
  setInterval(() => {
    const clientCount = CLIENTS.size;
    const connectedCount = Array.from(CLIENTS.values()).filter(c => c.status === 'connected').length;
    console.log(`[KeepAlive] Clients: ${clientCount} | Connected: ${connectedCount} | Uptime: ${Math.floor(process.uptime())}s`);
    
    CLIENTS.forEach((clientData, clientId) => {
      if (clientData.status === 'disconnected') {
        console.log(`[${clientId}] Detected disconnected client, attempting reconnect...`);
        try {
          clientData.client.initialize().catch(e => {
            console.error(`[${clientId}] KeepAlive reconnect failed:`, e.message);
          });
        } catch (e) {
          console.error(`[${clientId}] KeepAlive error:`, e.message);
        }
      }
    });
  }, KEEP_ALIVE_INTERVAL);
  
  setInterval(() => {
    if (BASE_URL && BASE_URL.startsWith('http')) {
      axios.get(`${BASE_URL}/health`)
        .then(response => {
          console.log(`[SelfPing] Success - Uptime: ${response.data.uptime}s, Clients: ${response.data.clients}`);
        })
        .catch(error => {
          console.error('[SelfPing] Failed:', error.message);
        });
    }
  }, SELF_PING_INTERVAL);
  
  console.log('Keep-alive mechanism enabled (5-minute client check + 25-minute self-ping)');
  console.log('⚠️  NOTE: For Heroku free/hobby dynos, add external uptime monitoring (UptimeRobot, etc.) to prevent sleeping.');
}

// Graceful shutdown handler
function gracefulShutdown() {
  console.log('\nReceived shutdown signal, cleaning up...');
  
  const shutdownPromises = [];
  CLIENTS.forEach((clientData, clientId) => {
    console.log(`[${clientId}] Saving state...`);
    if (CLIENTS_DATA[clientId]) {
      CLIENTS_DATA[clientId].status = clientData.status;
      CLIENTS_DATA[clientId].lastShutdown = now();
    }
  });
  
  saveClients();
  console.log('All client states saved.');
  
  setTimeout(() => {
    console.log('Shutdown complete.');
    process.exit(0);
  }, 2000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at ${BASE_URL}\nVisit ${BASE_URL}/ for multi-client dashboard\nAdmin UI at ${BASE_URL}/admin?token=${ADMIN_UI_TOKEN}`);
  
  cleanupStaleLocks();
  
  setTimeout(() => {
    initializeSavedClients();
    setupKeepAlive();
    console.log('\n✅ WhatsApp Bot fully initialized and ready for 24/7 operation!');
  }, 2000);
});
