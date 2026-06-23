importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBz6Qex4MB1IL-YPypzgsH5MPUCyrlPXkg",
  authDomain: "crediplexpredict.firebaseapp.com",
  projectId: "crediplexpredict",
  storageBucket: "crediplexpredict.firebasestorage.app",
  messagingSenderId: "934288152519",
  appId: "1:934288152519:web:b8db4bf6f69870cb13ebe2"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || 'Crediplex';
  const body = payload.notification?.body || 'You have a new notification';
  self.registration.showNotification(title, {
    body,
    icon: 'https://i.postimg.cc/7hvV79Pp/file-000000007dd872438ee8e3a300b62930.png',
    badge: 'https://i.postimg.cc/7hvV79Pp/file-000000007dd872438ee8e3a300b62930.png',
    data: payload.data || {}
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('https://crediplex.name.ng')
  );
});
