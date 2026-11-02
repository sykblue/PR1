"use strict";

(() => {
  const content = document.getElementById("profile-content");
  if (!content) return;
  const ownerId = Number(content.dataset.profileUserId);
  function checkIdentity(user) {
    if (user?.id === ownerId) return;
    // Remove the previous account's rendered information before navigating away.
    content.hidden = true;
    window.location.replace(user ? "/profile" : "/login?next=%2Fprofile");
  }
  document.addEventListener("auth-changed", (event) => checkIdentity(event.detail.user));
  window.HairlineAuth.ready.then(() => checkIdentity(window.HairlineAuth.user)).catch(() => {});
})();
