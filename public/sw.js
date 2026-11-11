// Service worker mínimo: deixa o app instalável na tela inicial (e aparecer no "Compartilhar" do Android).
// Não guarda nada em cache: tudo vem sempre do servidor, então nunca mostra versão velha.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
