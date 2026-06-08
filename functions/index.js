const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();

const stripeSecretKey    = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

const PRICE_PLAN_MAP = {
  'price_1TeFGWRXW1evPVMUHPTm6XpL': { plan: 'pro',      billing: 'monthly' },
  'price_1TeFJLRXW1evPVMUM7vJgskA': { plan: 'pro',      billing: 'yearly'  },
  'price_1TeFKKRXW1evPVMU0WQj0uhx': { plan: 'lifetime', billing: 'once'    },
  'price_1TeFKpRXW1evPVMU5QSgaMur': { plan: 'export',   billing: 'once'    },
};

// Stripe Checkout セッション作成（フロントから呼ぶ）
exports.createCheckoutSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'ログインが必要です');

    const { priceId, successUrl, cancelUrl } = request.data;
    const uid = request.auth.uid;
    const planInfo = PRICE_PLAN_MAP[priceId];
    if (!planInfo) throw new HttpsError('invalid-argument', '無効なプランです');

    const stripe = require('stripe')(stripeSecretKey.value());
    const db = getFirestore();

    // Stripe カスタマーを取得または作成
    const userDoc = await db.collection('users').doc(uid).get();
    let customerId = userDoc.data()?.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { firebaseUid: uid } });
      customerId = customer.id;
      await db.collection('users').doc(uid).set({ stripeCustomerId: customerId }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: planInfo.billing === 'once' ? 'payment' : 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: uid,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return { url: session.url };
  }
);

// Stripe Webhook 受信
exports.stripeWebhook = onRequest(
  { secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    const stripe = require('stripe')(stripeSecretKey.value());

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        stripeWebhookSecret.value()
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const db = getFirestore();

    // 一時購入（lifetime / export）
    if (event.type === 'checkout.session.completed' && event.data.object.mode === 'payment') {
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
        expand: ['line_items'],
      });
      const uid = session.client_reference_id;
      const priceId = session.line_items?.data[0]?.price?.id;
      const planInfo = PRICE_PLAN_MAP[priceId];
      if (!uid || !planInfo) return res.status(200).send('OK');

      const update = { plan: planInfo.plan, updatedAt: FieldValue.serverTimestamp() };
      if (planInfo.plan === 'export') {
        // その年の12月31日まで有効
        update.planExpiry = new Date(new Date().getFullYear(), 11, 31).toISOString();
      }
      await db.collection('users').doc(uid).set(update, { merge: true });
    }

    // サブスク支払い成功（初回・更新どちらも）
    if (event.type === 'invoice.payment_succeeded' && event.data.object.subscription) {
      const invoice = event.data.object;
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      const priceId = subscription.items.data[0]?.price?.id;
      const planInfo = PRICE_PLAN_MAP[priceId];
      if (!planInfo || planInfo.billing === 'once') return res.status(200).send('OK');

      const customer = await stripe.customers.retrieve(invoice.customer);
      const uid = customer.metadata?.firebaseUid;
      if (!uid) return res.status(200).send('OK');

      const expiry = new Date();
      if (planInfo.billing === 'monthly') expiry.setMonth(expiry.getMonth() + 1);
      if (planInfo.billing === 'yearly')  expiry.setFullYear(expiry.getFullYear() + 1);

      await db.collection('users').doc(uid).set({
        plan: 'pro',
        planExpiry: expiry.toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    // サブスク解約 → free に戻す
    if (event.type === 'customer.subscription.deleted') {
      const customer = await stripe.customers.retrieve(event.data.object.customer);
      const uid = customer.metadata?.firebaseUid;
      if (uid) {
        await db.collection('users').doc(uid).set({
          plan: 'free',
          planExpiry: null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    res.status(200).send('OK');
  }
);
