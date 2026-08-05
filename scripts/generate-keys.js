// scripts/generate-keys.js
// Gera todas as chaves necessárias para correr o relay

import webpush from 'web-push';
import { Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';

console.log('');
console.log('🔑 A gerar chaves para o Pombo Relay...');
console.log('');

// Gerar VAPID keys (para Web Push)
const vapidKeys = webpush.generateVAPIDKeys();

// Gerar carteira Ethereum para o relay
const wallet = Wallet.createRandom();

console.log('═══════════════════════════════════════════════════');
console.log('  CHAVES GERADAS - Adiciona ao teu .env');
console.log('═══════════════════════════════════════════════════');
console.log('');
console.log('# Ethereum (identidade do relay na rede Streamr)');
console.log(`RELAY_PRIVATE_KEY=${wallet.privateKey}`);
console.log('');
console.log('# VAPID (para Web Push - FCM/APNS)');
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log(`VAPID_EMAIL=admin@example.com`);
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('');
console.log(`📍 Relay Address: ${wallet.address}`);
console.log('');
console.log('⚠️  IMPORTANTE:');
console.log('   - Guarda a RELAY_PRIVATE_KEY em segurança!');
console.log('   - A VAPID_PUBLIC_KEY vai ser usada pelos clientes');
console.log('   - O Relay Address é público (para clientes se registarem)');
console.log('');

// Criar ficheiro .env se não existir
const envPath = path.join(process.cwd(), '.env');
const envExamplePath = path.join(process.cwd(), '.env.example');

if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    console.log('📝 A criar .env a partir de .env.example...');
    
    let envContent = fs.readFileSync(envExamplePath, 'utf8');
    
    // Substituir valores placeholder
    envContent = envContent.replace('RELAY_PRIVATE_KEY=0x...', `RELAY_PRIVATE_KEY=${wallet.privateKey}`);
    envContent = envContent.replace('VAPID_PUBLIC_KEY=...', `VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
    envContent = envContent.replace('VAPID_PRIVATE_KEY=...', `VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
    
    fs.writeFileSync(envPath, envContent);
    console.log('✅ Ficheiro .env criado!');
} else if (fs.existsSync(envPath)) {
    console.log('⚠️  Ficheiro .env já existe. Copia as chaves manualmente.');
}

console.log('');
