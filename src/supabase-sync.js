(function () {
  const CLIENT_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
  const config = window.APP_SUPABASE_CONFIG || {};
  let client = null;
  let ready = false;
  let channel = null;

  function isConfigured() {
    return Boolean(config.enabled && config.url && config.anonKey && config.table && config.documentId);
  }

  async function init() {
    if (ready) {
      return { ok: true, mode: "cloud" };
    }

    if (!isConfigured()) {
      return { ok: false, mode: "local", reason: "supabase-disabled" };
    }

    const { createClient } = await import(CLIENT_URL);
    client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    ready = true;
    return { ok: true, mode: "cloud" };
  }

  async function load() {
    if (!ready) return null;
    const { data, error } = await client
      .from(config.table)
      .select("state")
      .eq("id", config.documentId)
      .maybeSingle();

    if (error) throw error;
    return data?.state ? hydrateStatePhotos(data.state) : null;
  }

  async function save(state) {
    if (!ready) return;
    const { error } = await client.from(config.table).upsert({
      id: config.documentId,
      state,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  function onRemoteState(callback, onError) {
    if (!ready) return () => {};
    channel?.unsubscribe();
    channel = client
      .channel("app-state-sync")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: config.table,
          filter: `id=eq.${config.documentId}`,
        },
        (payload) => {
          if (payload.new?.state) {
            hydrateStatePhotos(payload.new.state)
              .then(callback)
              .catch(() => callback(payload.new.state));
          }
        },
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") onError?.(new Error("Supabase realtime error"));
      });

    return () => channel?.unsubscribe();
  }

  async function uploadPhoto(dataUrl, fileName = "photo.jpg") {
    if (!ready || !dataUrl.startsWith("data:")) return dataUrl;

    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "-") || "photo.jpg";
    const path = `photos/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await client.storage.from(config.storageBucket).upload(path, blob, {
      contentType: blob.type || "image/jpeg",
      upsert: false,
    });
    if (error) throw error;

    const { data, error: signedError } = await client.storage
      .from(config.storageBucket)
      .createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signedError) throw signedError;

    return {
      src: data?.signedUrl || dataUrl,
      path,
    };
  }

  function inferPhotoPath(src) {
    if (!src || !config.storageBucket) return "";
    const markers = [
      `/storage/v1/object/public/${config.storageBucket}/`,
      `/storage/v1/object/sign/${config.storageBucket}/`,
    ];
    const marker = markers.find((item) => src.includes(item));
    if (!marker) return "";
    const tail = src.split(marker)[1]?.split("?")[0] || "";
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  }

  async function resolvePhoto(photo) {
    if (!photo || !ready) return photo;
    const path = photo.path || inferPhotoPath(photo.src);
    if (!path) return photo;

    const { data, error } = await client.storage.from(config.storageBucket).createSignedUrl(path, 60 * 60 * 24 * 7);
    if (error || !data?.signedUrl) return { ...photo, path };
    return {
      ...photo,
      path,
      src: data.signedUrl,
    };
  }

  async function hydrateStatePhotos(state) {
    if (!state) return state;
    const next = structuredClone(state);
    if (Array.isArray(next.goods)) {
      for (const item of next.goods) {
        if (Array.isArray(item.photos)) {
          item.photos = await Promise.all(item.photos.map(resolvePhoto));
        }
      }
    }
    if (Array.isArray(next.arrivals)) {
      for (const arrival of next.arrivals) {
        if (Array.isArray(arrival.photos)) {
          arrival.photos = await Promise.all(arrival.photos.map(resolvePhoto));
        }
      }
    }
    return next;
  }

  async function getUser() {
    if (!ready) return null;
    const { data, error } = await client.auth.getUser();
    if (error) return null;
    return data?.user || null;
  }

  async function signIn(email, password) {
    if (!ready) throw new Error("Supabase не подключен");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  }

  async function signOut() {
    if (!ready) return;
    await client.auth.signOut();
  }

  window.cloudStore = {
    init,
    load,
    save,
    uploadPhoto,
    onRemoteState,
    getUser,
    signIn,
    signOut,
    isReady: () => ready,
    isConfigured,
    requiresAuth: () => Boolean(config.requireAuth),
  };
})();
