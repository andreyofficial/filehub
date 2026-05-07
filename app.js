(function () {
  const QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
  const MAX_PRICE = 5;

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const filePreview = document.getElementById("file-preview");
  const titleInput = document.getElementById("listing-title");
  const publishBtn = document.getElementById("publish-btn");
  const listingContainer = document.getElementById("listing-container");
  const featuredRoot = document.getElementById("featured-root");
  const toastEl = document.getElementById("toast");
  const modal = document.getElementById("checkout-modal");
  const checkoutBody = document.getElementById("checkout-body");
  const checkoutCancel = document.getElementById("checkout-cancel");
  const checkoutConfirm = document.getElementById("checkout-confirm");
  const priceUsdSlider = document.getElementById("price-usd");
  const priceUsdOut = document.getElementById("price-usd-out");
  const userEmailEl = document.getElementById("user-email");
  const btnLogout = document.getElementById("btn-logout");

  /** @type {File[]} */
  let selectedFiles = [];
  let pendingListing = null;
  let listings = [];
  const purchaseSet = new Set();
  let isAdmin = false;

  function getToken() {
    return localStorage.getItem("filehub_token");
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem("filehub_user") || "{}");
    } catch {
      return {};
    }
  }

  function currentUserId() {
    return getUser().id || null;
  }

  function authHeaders() {
    const t = getToken();
    return t ? { Authorization: "Bearer " + t } : {};
  }

  function requireAuth() {
    if (!getToken()) {
      location.href = "signin.html?next=" + encodeURIComponent("website.html");
      return false;
    }
    return true;
  }

  function canRemoveListing(listing) {
    if (!listing) return false;
    return listing.ownerId === currentUserId() || isAdmin;
  }

  const ICON_DL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const ICON_STAR =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove("show"), 3200);
  }

  async function fetchListings() {
    const r = await fetch("/api/listings");
    if (!r.ok) throw new Error("Could not load listings");
    listings = await r.json();
  }

  async function fetchPurchases() {
    purchaseSet.clear();
    const r = await fetch("/api/me/purchases", { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    (j.listingIds || []).forEach((id) => purchaseSet.add(id));
  }

  async function refreshMe() {
    try {
      const r = await fetch("/api/me", { headers: authHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      isAdmin = Boolean(j.isAdmin);
      const u = { ...getUser(), ...j };
      localStorage.setItem("filehub_user", JSON.stringify(u));
      if (userEmailEl) userEmailEl.textContent = u.email || "";
    } catch (_) {}
  }

  async function handleCheckoutReturn() {
    const p = new URLSearchParams(location.search);
    const st = p.get("checkout");
    const token = p.get("token");

    if (st === "paypal_success" && token) {
      try {
        const r = await fetch("/api/paypal/capture?token=" + encodeURIComponent(token), { headers: authHeaders() });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Payment verify failed");
        showToast("PayPal payment complete — you can download.");
      } catch (e) {
        showToast(e.message || "Payment verify failed");
      }
      history.replaceState({}, "", "website.html");
    } else if (st === "paypal_cancel") {
      showToast("PayPal checkout canceled");
      history.replaceState({}, "", "website.html");
    }
  }

  function formatSize(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
    return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function nf(n) {
    return new Intl.NumberFormat().format(n);
  }

  function clampPriceUsd(n) {
    if (typeof n !== "number" || Number.isNaN(n)) return 0;
    return Math.min(MAX_PRICE, Math.max(0, Math.round(n)));
  }

  function getListingPriceUsd(listing) {
    if (!listing) return 0;
    const v = listing.priceUsd;
    if (typeof v === "number" && !Number.isNaN(v)) return clampPriceUsd(v);
    return 0;
  }

  function formatPriceMoney(usd) {
    const u = clampPriceUsd(usd);
    if (u === 0) return "Free";
    return "$" + u + ".00";
  }

  function selectedBatchBytes() {
    return selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
  }

  function myUsedBytes() {
    const uid = currentUserId();
    if (!uid) return 0;
    return listings.filter((l) => l.ownerId === uid).reduce((s, l) => s + (Number(l.size) || 0), 0);
  }

  function getQuotaRemaining() {
    return Math.max(0, QUOTA_BYTES - myUsedBytes());
  }

  function updateQuotaLine() {
    const el = document.getElementById("quota-line");
    if (!el) return;
    const used = myUsedBytes();
    const staged = selectedBatchBytes();
    el.textContent =
      "Your uploads: " +
      formatSize(used) +
      " / " +
      formatSize(QUOTA_BYTES) +
      " (" +
      formatSize(getQuotaRemaining()) +
      " free). Staging: " +
      formatSize(staged) +
      " (max " +
      formatSize(QUOTA_BYTES) +
      " per publish).";
  }

  function syncPriceSlider() {
    if (!priceUsdSlider || !priceUsdOut) return;
    const v = clampPriceUsd(Number(priceUsdSlider.value));
    priceUsdSlider.value = String(v);
    priceUsdOut.textContent = formatPriceMoney(v);
    priceUsdSlider.setAttribute("aria-valuenow", String(v));
  }

  function updatePublishState() {
    const title = titleInput.value.trim();
    publishBtn.disabled = !(selectedFiles.length > 0 && title.length >= 2);
  }

  function renderFilePreview() {
    filePreview.innerHTML = "";
    selectedFiles.forEach((file) => {
      const pill = document.createElement("div");
      pill.className = "file-pill";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = file.name;
      const sizeSpan = document.createElement("span");
      sizeSpan.style.color = "var(--muted-dim)";
      sizeSpan.textContent = formatSize(file.size);
      pill.appendChild(nameSpan);
      pill.appendChild(sizeSpan);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove file");
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        selectedFiles = selectedFiles.filter((x) => x !== file);
        syncFileInput();
        renderFilePreview();
        updatePublishState();
      });
      pill.appendChild(rm);
      filePreview.appendChild(pill);
    });
    updateQuotaLine();
  }

  function syncFileInput() {
    const dt = new DataTransfer();
    selectedFiles.forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;
  }

  function validateAndAddFiles(newFiles) {
    const arr = Array.from(newFiles || []).filter(Boolean);
    if (arr.length === 0) return;
    let next = selectedFiles.slice();
    for (const file of arr) {
      if (file.size > QUOTA_BYTES) {
        showToast("Each file must be 5 GB or smaller: " + file.name);
        continue;
      }
      const batchAfter = next.reduce((s, f) => s + f.size, 0) + file.size;
      if (batchAfter > QUOTA_BYTES) {
        showToast("This set would exceed 5 GB per listing. Remove files or pick a smaller batch.");
        return;
      }
      const accountAfter = myUsedBytes() + batchAfter;
      if (accountAfter > QUOTA_BYTES) {
        showToast("Not enough account space left (5 GB total). Remove a listing or shrink this batch.");
        return;
      }
      next.push(file);
    }
    selectedFiles = next;
    syncFileInput();
    renderFilePreview();
    updatePublishState();
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    validateAndAddFiles(fileInput.files);
  });
  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    validateAndAddFiles(e.dataTransfer.files);
  });
  titleInput.addEventListener("input", updatePublishState);

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function triggerDownload(listing) {
    try {
      const r = await fetch("/api/listings/" + encodeURIComponent(listing.id) + "/download", { headers: authHeaders() });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Download failed");
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition");
      let name = (listing.fileCount || 0) > 1 ? listing.title + ".zip" : listing.fileName;
      if (cd && cd.includes("filename=")) {
        const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
        if (m) name = decodeURIComponent(m[1].replace(/['"]/g, ""));
      }
      downloadBlob(blob, name);
      showToast("Download started.");
      await fetchListings();
      renderAll();
    } catch (e) {
      showToast(e.message || "Download failed");
    }
  }

  function removeListing(listing) {
    return async () => {
      try {
        const r = await fetch("/api/listings/" + encodeURIComponent(listing.id), {
          method: "DELETE",
          headers: authHeaders(),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Remove failed");
        await fetchListings();
        await fetchPurchases();
        await refreshMe();
        renderAll();
        showToast("Listing removed.");
      } catch (e) {
        showToast(e.message || "Remove failed");
      }
    };
  }

  function canDownload(listing) {
    if (listing.ownerId === currentUserId()) return true;
    if (getListingPriceUsd(listing) === 0) return true;
    return purchaseSet.has(listing.id);
  }

  function openCheckout(listing) {
    pendingListing = listing;
    const usd = getListingPriceUsd(listing);
    checkoutBody.textContent =
      "You will go to PayPal to pay " +
      formatPriceMoney(usd) +
      " for “" +
      listing.title +
      "”.";
    checkoutConfirm.textContent = "Continue to PayPal";
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeCheckout() {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    pendingListing = null;
  }

  checkoutCancel.addEventListener("click", closeCheckout);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeCheckout();
  });

  checkoutConfirm.addEventListener("click", async () => {
    if (!pendingListing) return;
    checkoutConfirm.disabled = true;
    try {
      const r = await fetch("/api/paypal/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ listingId: pendingListing.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not start PayPal checkout");
      if (j.approvalUrl) {
        location.href = j.approvalUrl;
        return;
      }
      throw new Error("No PayPal approval URL");
    } catch (e) {
      showToast(e.message || "Checkout failed");
    } finally {
      checkoutConfirm.disabled = false;
    }
  });

  function featuredThumbSvg() {
    const wrap = document.createElement("div");
    wrap.className = "thumb-svg";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 120 120");
    svg.innerHTML = document.getElementById("icon-file-hero").innerHTML;
    wrap.appendChild(svg);
    return wrap;
  }

  function smallFileIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.innerHTML =
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>';
    return svg;
  }

  function bylineFor(listing) {
    if (!listing || !listing.ownerEmail) return "by Seller";
    return "by " + listing.ownerEmail;
  }

  function fileSummary(listing) {
    const fc = listing.fileCount || 1;
    const bits = [fc > 1 ? fc + " files" : listing.fileName, formatSize(listing.size)];
    return bits.join(" · ");
  }

  function renderFeatured() {
    featuredRoot.innerHTML = "";
    const reversed = listings.slice().reverse();
    const featured = reversed[0];

    const card = document.createElement("article");
    card.className = "featured-card";

    const visual = document.createElement("div");
    visual.className = "featured-visual";
    const thumb = document.createElement("div");
    thumb.className = "featured-thumb";
    thumb.appendChild(featuredThumbSvg());
    visual.appendChild(thumb);

    const badge = document.createElement("span");
    badge.className = "featured-badge";
    badge.innerHTML = ICON_STAR + " Featured";
    visual.appendChild(badge);
    card.appendChild(visual);

    const body = document.createElement("div");
    body.className = "featured-body";

    if (!featured) {
      const h3 = document.createElement("h3");
      h3.textContent = "Your newest upload is featured here";
      const by = document.createElement("p");
      by.className = "byline";
      by.textContent = "by You";
      const desc = document.createElement("p");
      desc.className = "desc";
      desc.textContent =
        "Upload one or many files (total under 5 GB per listing). Price from $0 (free) to $5. Paid buyers check out with PayPal.";
      const stats = document.createElement("div");
      stats.className = "stats";
      stats.innerHTML =
        "<span>" + ICON_DL + " 0 downloads</span><span>" + ICON_STAR + " New</span>";
      const foot = document.createElement("div");
      foot.className = "featured-footer";
      const price = document.createElement("span");
      price.className = "price-big";
      price.textContent = "$0 – $5";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-buy";
      btn.textContent = "Buy now";
      btn.disabled = true;
      foot.appendChild(price);
      foot.appendChild(btn);
      body.appendChild(h3);
      body.appendChild(by);
      body.appendChild(desc);
      body.appendChild(stats);
      body.appendChild(foot);
      card.appendChild(body);
      featuredRoot.appendChild(card);
      return;
    }

    const h3 = document.createElement("h3");
    h3.textContent = featured.title;
    const by = document.createElement("p");
    by.className = "byline";
    by.textContent = bylineFor(featured);
    const desc = document.createElement("p");
    desc.className = "desc";
    desc.textContent =
      fileSummary(featured) + " · Listed " + new Date(featured.createdAt).toLocaleDateString() + ".";

    const stats = document.createElement("div");
    stats.className = "stats";
    const dc = featured.downloadCount || 0;
    const dlSpan = document.createElement("span");
    dlSpan.innerHTML = ICON_DL + " " + nf(dc) + " downloads";
    const starSpan = document.createElement("span");
    starSpan.innerHTML = ICON_STAR + " 4.8 / 5";
    stats.appendChild(dlSpan);
    stats.appendChild(starSpan);

    const foot = document.createElement("div");
    foot.className = "featured-footer";
    const price = document.createElement("span");
    price.className = "price-big";
    price.textContent = formatPriceMoney(getListingPriceUsd(featured));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-buy";

    if (canDownload(featured)) {
      btn.textContent = "Download";
      btn.addEventListener("click", () => triggerDownload(featured));
    } else {
      btn.textContent = "Buy now";
      btn.addEventListener("click", () => openCheckout(featured));
    }

    foot.appendChild(price);
    foot.appendChild(btn);
    body.appendChild(h3);
    body.appendChild(by);
    body.appendChild(desc);
    body.appendChild(stats);
    body.appendChild(foot);

    if (canRemoveListing(featured)) {
      const unlink = document.createElement("button");
      unlink.type = "button";
      unlink.className = "link-quiet";
      unlink.textContent = isAdmin && featured.ownerId !== currentUserId() ? "Remove (admin)" : "Remove listing";
      unlink.style.marginTop = "0.5rem";
      unlink.addEventListener("click", removeListing(featured));
      body.appendChild(unlink);
    }

    card.appendChild(body);
    featuredRoot.appendChild(card);
  }

  function renderCommunity() {
    const reversed = listings.slice().reverse();
    const rest = reversed.slice(1);
    listingContainer.innerHTML = "";

    if (rest.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = listings.length === 0 ? "No community listings yet." : "Only one listing — it is featured above.";
      listingContainer.appendChild(empty);
      return;
    }

    rest.forEach((listing) => {
      const card = document.createElement("article");
      card.className = "community-card";
      const thumb = document.createElement("div");
      thumb.className = "cc-thumb";
      thumb.appendChild(smallFileIcon());
      const right = document.createElement("div");

      const top = document.createElement("div");
      top.className = "cc-top";
      const h3 = document.createElement("h3");
      h3.className = "cc-title";
      h3.textContent = listing.title;
      const tag = document.createElement("span");
      tag.className = "tag tag-price";
      tag.textContent = formatPriceMoney(getListingPriceUsd(listing));
      top.appendChild(h3);
      top.appendChild(tag);

      const meta = document.createElement("div");
      meta.className = "cc-meta";
      meta.textContent =
        bylineFor(listing) +
        " · " +
        fileSummary(listing) +
        " · " +
        nf(listing.downloadCount || 0) +
        " dl";

      const actions = document.createElement("div");
      actions.className = "cc-actions";
      if (canDownload(listing)) {
        const dl = document.createElement("button");
        dl.type = "button";
        dl.className = "btn-buy";
        dl.textContent = "Download";
        dl.addEventListener("click", () => triggerDownload(listing));
        actions.appendChild(dl);
      } else {
        const buy = document.createElement("button");
        buy.type = "button";
        buy.className = "btn-buy";
        buy.textContent = "Buy now";
        buy.addEventListener("click", () => openCheckout(listing));
        actions.appendChild(buy);
      }

      right.appendChild(top);
      right.appendChild(meta);
      right.appendChild(actions);
      if (canRemoveListing(listing)) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "link-quiet";
        rm.textContent = isAdmin && listing.ownerId !== currentUserId() ? "Remove (admin)" : "Remove";
        rm.addEventListener("click", removeListing(listing));
        right.appendChild(rm);
      }
      card.appendChild(thumb);
      card.appendChild(right);
      listingContainer.appendChild(card);
    });
  }

  function renderAll() {
    renderFeatured();
    renderCommunity();
    updateQuotaLine();
  }

  publishBtn.addEventListener("click", async () => {
    const title = titleInput.value.trim();
    if (selectedFiles.length === 0 || title.length < 2) return;

    const batch = selectedBatchBytes();
    if (batch > QUOTA_BYTES) {
      showToast("This batch is over 5 GB.");
      return;
    }
    if (myUsedBytes() + batch > QUOTA_BYTES) {
      showToast("Not enough account storage left.");
      return;
    }

    const priceUsd = clampPriceUsd(Number(priceUsdSlider.value));
    const fd = new FormData();
    fd.append("title", title);
    fd.append("priceUsd", String(priceUsd));
    for (const f of selectedFiles) {
      fd.append("files", f, f.name);
    }

    publishBtn.disabled = true;
    try {
      const r = await fetch("/api/listings", { method: "POST", headers: authHeaders(), body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Publish failed");

      selectedFiles = [];
      syncFileInput();
      titleInput.value = "";
      priceUsdSlider.value = "0";
      syncPriceSlider();
      renderFilePreview();
      updatePublishState();
      await fetchListings();
      renderAll();
      showToast("Published.");
    } catch (e) {
      showToast(e.message || "Publish failed");
    } finally {
      publishBtn.disabled = false;
    }
  });

  if (priceUsdSlider) {
    priceUsdSlider.addEventListener("input", syncPriceSlider);
    syncPriceSlider();
  }

  if (btnLogout) {
    btnLogout.addEventListener("click", () => {
      localStorage.removeItem("filehub_token");
      localStorage.removeItem("filehub_user");
      location.href = "signin.html";
    });
  }

  (async function init() {
    if (!requireAuth()) return;
    await refreshMe();
    if (userEmailEl && !userEmailEl.textContent.trim()) {
      userEmailEl.textContent = getUser().email || "";
    }
    await handleCheckoutReturn();
    try {
      await fetchListings();
      await fetchPurchases();
    } catch (e) {
      showToast(e.message || "Failed to load data");
    }
    renderAll();
  })();
})();
