const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

initializeApp();

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

const PRICE_PLAN_MAP = {
  'price_1TeFGWRXW1evPVMUHPTm6XpL': { plan: 'pro',      billing: 'monthly' },
  'price_1TeFJLRXW1evPVMUM7vJgskA': { plan: 'pro',      billing: 'yearly'  },
  'price_1TeFKKRXW1evPVMU0WQj0uhx': { plan: 'lifetime', billing: 'once'    },
  'price_1TeFKpRXW1evPVMU5QSgaMur': { plan: 'export',   billing: 'once'    },
};

function getBillingRef(db, uid) {
  return db.collection('users').doc(uid).collection('billing').doc('rakuthrough');
}

function getSubscriptionId(invoice) {
  const value = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function getSubscriptionExpiry(subscription) {
  const periodEnd = subscription.items?.data[0]?.current_period_end
    ?? subscription.current_period_end;
  if (periodEnd) return new Date(periodEnd * 1000).toISOString();

  const priceId = subscription.items?.data[0]?.price?.id;
  const planInfo = PRICE_PLAN_MAP[priceId];
  const expiry = new Date();
  if (planInfo?.billing === 'monthly') expiry.setMonth(expiry.getMonth() + 1);
  if (planInfo?.billing === 'yearly') expiry.setFullYear(expiry.getFullYear() + 1);
  return expiry.toISOString();
}

async function getUidFromSubscription(stripe, subscription) {
  if (subscription.metadata?.app === 'rakuthrough' && subscription.metadata?.firebaseUid) {
    return subscription.metadata.firebaseUid;
  }

  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  return customer.metadata?.firebaseUid ?? null;
}

exports.createCheckoutSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login is required.');

    const { priceId, successUrl, cancelUrl } = request.data;
    const uid = request.auth.uid;
    const planInfo = PRICE_PLAN_MAP[priceId];
    if (!planInfo) throw new HttpsError('invalid-argument', 'Invalid plan.');

    const stripe = require('stripe')(stripeSecretKey.value());
    const db = getFirestore();
    const billingRef = getBillingRef(db, uid);
    const billingDoc = await billingRef.get();
    let customerId = billingDoc.data()?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { firebaseUid: uid, app: 'rakuthrough' },
      });
      customerId = customer.id;
      await billingRef.set({
        stripeCustomerId: customerId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    const isSubscription = planInfo.billing !== 'once';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isSubscription ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: uid,
      metadata: { firebaseUid: uid, app: 'rakuthrough' },
      ...(isSubscription ? {
        subscription_data: { metadata: { firebaseUid: uid, app: 'rakuthrough' } },
      } : {}),
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return { url: session.url };
  }
);

exports.createCustomerPortalSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login is required.');

    const returnUrl = request.data?.returnUrl;
    if (typeof returnUrl !== 'string') {
      throw new HttpsError('invalid-argument', 'A return URL is required.');
    }
    let parsedReturnUrl;
    try {
      parsedReturnUrl = new URL(returnUrl);
    } catch {
      throw new HttpsError('invalid-argument', 'Invalid return URL.');
    }
    const isLocal = parsedReturnUrl.hostname === 'localhost' || parsedReturnUrl.hostname === '127.0.0.1';
    if (parsedReturnUrl.protocol !== 'https:' && !isLocal) {
      throw new HttpsError('invalid-argument', 'Invalid return URL.');
    }

    const db = getFirestore();
    const billingDoc = await getBillingRef(db, request.auth.uid).get();
    const customerId = billingDoc.data()?.stripeCustomerId;
    if (!customerId) {
      throw new HttpsError('failed-precondition', 'No RakuThrough billing account was found.');
    }

    const stripe = require('stripe')(stripeSecretKey.value());
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }
);

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
    const eventRef = db.doc(`stripeApps/rakuthrough/events/${event.id}`);
    const eventDoc = await eventRef.get();
    if (eventDoc.data()?.status === 'processed') return res.status(200).send('OK');

    const markProcessed = () => eventRef.set({
      type: event.type,
      status: 'processed',
      processedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000),
    }, { merge: true });

    if (event.type === 'checkout.session.completed') {
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
        expand: ['line_items'],
      });
      const uid = session.client_reference_id;
      const priceId = session.line_items?.data[0]?.price?.id;
      const planInfo = PRICE_PLAN_MAP[priceId];
      if (!uid || !planInfo) {
        await markProcessed();
        return res.status(200).send('OK');
      }

      const customerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;
      const update = {
        stripeCustomerId: customerId,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (session.mode === 'payment') {
        update.plan = planInfo.plan;
        update.subscriptionStatus = 'active';
        if (planInfo.plan === 'export') {
          update.planExpiry = new Date(new Date().getFullYear(), 11, 31).toISOString();
        }
      }
      await getBillingRef(db, uid).set(update, { merge: true });
      if (customerId) {
        await db.doc(`stripeApps/rakuthrough/customers/${customerId}`).set({
          uid,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const subscriptionId = getSubscriptionId(invoice);
      if (!subscriptionId) {
        await markProcessed();
        return res.status(200).send('OK');
      }

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      const planInfo = PRICE_PLAN_MAP[priceId];
      if (!planInfo || planInfo.billing === 'once') {
        await markProcessed();
        return res.status(200).send('OK');
      }

      const uid = await getUidFromSubscription(stripe, subscription);
      if (!uid) {
        await markProcessed();
        return res.status(200).send('OK');
      }

      const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;
      await getBillingRef(db, uid).set({
        plan: 'pro',
        stripeCustomerId: customerId,
        subscriptionStatus: 'active',
        planExpiry: getSubscriptionExpiry(subscription),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const priceId = subscription.items?.data[0]?.price?.id;
      const planInfo = PRICE_PLAN_MAP[priceId];
      if (!planInfo || planInfo.billing === 'once') {
        await markProcessed();
        return res.status(200).send('OK');
      }

      const uid = await getUidFromSubscription(stripe, subscription);
      if (uid) {
        await getBillingRef(db, uid).set({
          plan: 'free',
          stripeCustomerId: FieldValue.delete(),
          subscriptionStatus: 'canceled',
          planExpiry: null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    await markProcessed();
    return res.status(200).send('OK');
  }
);
