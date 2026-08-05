// scripts/test-push.js
// ============================================
// Script de teste para verificar o relay
// ============================================
// Uso: npm test
// Este script simula um cliente a enviar uma notificação

import 'dotenv/config';
import StreamrClient from '@streamr/sdk';
import { ethers } from 'ethers';

const config = {
    relayPrivateKey: process.env.RELAY_PRIVATE_KEY,
    pushStreamId: process.env.PUSH_STREAM_ID || 'pombo/push/notifications',
    powDifficulty: parseInt(process.env.POW_DIFFICULTY || '4')
};

console.log('');
console.log('🧪 TESTE DO POMBO RELAY');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// Gerar uma carteira de teste
const testWallet = ethers.Wallet.createRandom();
console.log(`📍 Carteira de teste: ${testWallet.address}`);

// K-Anonymity: Use small tags for better privacy with few users
// TAG_BYTES=1 gives 256 possible tags → K≈users/256
const TAG_BYTES = 1;
const TAG_HEX_CHARS = 2 + (TAG_BYTES * 2);

// Calcular tag (como o cliente faria)
function getTag(walletAddress) {
    const hash = ethers.keccak256(walletAddress.toLowerCase());
    return hash.slice(0, TAG_HEX_CHARS); // "0x" + 2 chars (1 byte = 256 tags)
}

// Get current epoch (10-second windows) for replay attack prevention
function getCurrentEpoch() {
    return Math.floor(Date.now() / 10000);
}

// Gerar PoW (com epoch para prevenir replay attacks)
async function generatePoW(tag, difficulty) {
    console.log(`🔄 A gerar PoW (dificuldade: ${difficulty})...`);
    const startTime = Date.now();
    const target = '0'.repeat(difficulty);
    const epoch = getCurrentEpoch();
    let nonce = 0;
    
    while (true) {
        // IMPORTANTE: Formato deve ser ${tag}:${epoch}:${nonce}
        const data = `${tag}:${epoch}:${nonce}`;
        const hash = ethers.keccak256(ethers.toUtf8Bytes(data));
        
        if (hash.slice(2).startsWith(target)) {
            const elapsed = Date.now() - startTime;
            console.log(`✅ PoW encontrado em ${elapsed}ms (nonce: ${nonce}, epoch: ${epoch})`);
            return { nonce, pow: hash, epoch };
        }
        
        nonce++;
        
        // Progresso a cada 100k tentativas
        if (nonce % 100000 === 0) {
            process.stdout.write('.');
        }
        
        // Timeout de segurança
        if (Date.now() - startTime > 60000) {
            throw new Error('PoW timeout - dificuldade muito alta');
        }
    }
}

async function main() {
    // Conectar ao Streamr
    console.log('🔄 A conectar ao Streamr...');
    
    const client = new StreamrClient({
        auth: { privateKey: testWallet.privateKey }
    });
    
    const address = await client.getAddress();
    console.log(`✅ Conectado como: ${address}`);
    
    // Gerar tag para o teste
    const tag = getTag(testWallet.address);
    console.log(`📋 Tag de teste: ${tag}`);
    
    // Gerar PoW (agora retorna epoch também)
    const { nonce, pow, epoch } = await generatePoW(tag, config.powDifficulty);
    
    // Criar payload (DEVE incluir epoch para compatibilidade com relay atual)
    const payload = {
        type: 'notification',
        tag,
        nonce,
        pow,
        epoch,
        timestamp: Date.now()
    };
    
    console.log('');
    console.log('📦 Payload:');
    console.log(JSON.stringify(payload, null, 2));
    console.log('');
    
    // Publicar no stream de notificações
    console.log(`📤 A publicar em: ${config.pushStreamId}...`);
    
    try {
        await client.publish(config.pushStreamId, payload);
        console.log('✅ Mensagem publicada com sucesso!');
        console.log('');
        console.log('👀 Verifica os logs do relay para ver se recebeu a mensagem.');
        console.log('   (Não vai enviar push porque não há dispositivos registados com esta tag)');
    } catch (error) {
        console.error('❌ Erro ao publicar:', error.message);
        
        if (error.message?.includes('not found')) {
            console.log('');
            console.log('💡 O stream ainda não existe.');
            console.log('   Inicia o relay primeiro: npm start');
        }
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    
    // Cleanup
    await client.destroy();
    process.exit(0);
}

main().catch(error => {
    console.error('❌ Erro:', error);
    process.exit(1);
});
