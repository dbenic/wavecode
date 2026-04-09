import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from './useApi';

export function usePush() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const isSupported = 'serviceWorker' in navigator && 'PushManager' in window;
    setSupported(isSupported);

    if (isSupported) {
      // Register service worker
      navigator.serviceWorker.register('/sw.js').catch(() => {});

      // Check if already subscribed
      navigator.serviceWorker.ready.then((reg) => {
        reg.pushManager.getSubscription().then((sub) => {
          setSubscribed(!!sub);
        });
      });
    }
  }, []);

  const subscribe = useCallback(async () => {
    if (!supported || subscribed) return;
    setLoading(true);

    try {
      const { publicKey } = await apiGet<{ publicKey: string }>('/push/vapid-key');

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const subJson = sub.toJSON();
      await apiPost('/push/subscribe', {
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      });

      setSubscribed(true);
    } catch {
      // subscription failed
    } finally {
      setLoading(false);
    }
  }, [supported, subscribed]);

  const unsubscribe = useCallback(async () => {
    if (!subscribed) return;
    setLoading(true);

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await apiPost('/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch {
      // unsubscribe failed
    } finally {
      setLoading(false);
    }
  }, [subscribed]);

  return { supported, subscribed, subscribe, unsubscribe, loading };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
