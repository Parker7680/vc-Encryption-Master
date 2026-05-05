/*
 * Encryption Master - Cryptography Utilities
 */

const ITERATIONS = 100000;

export function logInfo(message: string) {
    console.log(`[Encryption Master] [INFO] ${message}`);
}

export function logError(message: string, error?: any) {
    console.error(`[Encryption Master] [ERROR] ${message}`, error);
}

export async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
    logInfo("Starting key derivation...");
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    const aesKey = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: encoder.encode(salt),
            iterations: ITERATIONS,
            hash: "SHA-256",
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    logInfo("Key derivation successful.");
    return aesKey;
}
// --- TEXT ENCRYPTION ---

export async function encryptText(key: CryptoKey, text: string): Promise<string> {
    const encoder = new TextEncoder();
    const encodedText = encoder.encode(text);
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        encodedText
    );

    const ivBase64 = arrayBufferToBase64(iv);
    const cipherBase64 = arrayBufferToBase64(cipherBuffer);
    
    return `[EMENC]${ivBase64}:${cipherBase64}`;
}
export async function decryptText(keys: CryptoKey[], formattedString: string): Promise<string> {
    try {
        const data = formattedString.replace("[EMENC]", "");
        const [ivBase64, cipherBase64] = data.split(":");

        const iv = base64ToArrayBuffer(ivBase64);
        const cipherBuffer = base64ToArrayBuffer(cipherBase64);

        for (const key of keys) {
            try {
                const decryptedBuffer = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: iv },
                    key,
                    cipherBuffer
                );
                const decoder = new TextDecoder();
                return decoder.decode(decryptedBuffer);
            } catch (e) {
                continue;
            }
        }
        
        throw new Error("No matching key found.");
    } catch (error) {
        logError("Failed to decrypt text.", error);
        return "⚠️ [Encryption Master: Failed to decrypt]";
    }
}

// --- FILE ENCRYPTION (.EMD) ---

export async function encryptFileBuffer(key: CryptoKey, buffer: ArrayBuffer, fileName: string): Promise<ArrayBuffer> {
    logInfo(`Encrypting file buffer of size: ${buffer.byteLength} bytes`);
    
    const encoder = new TextEncoder();
    const nameBytes = encoder.encode(fileName);
    
    const nameLength = new Uint8Array([nameBytes.length]); 
    
    // [1-Byte Length] + [Filename Bytes] + [Original File Bytes]
    const dataToEncrypt = new Uint8Array(1 + nameBytes.length + buffer.byteLength);
    dataToEncrypt.set(nameLength, 0);
    dataToEncrypt.set(nameBytes, 1);
    dataToEncrypt.set(new Uint8Array(buffer), 1 + nameBytes.length);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        dataToEncrypt.buffer
    );

    const combined = new Uint8Array(iv.byteLength + cipherBuffer.byteLength);
    combined.set(new Uint8Array(iv), 0);
    combined.set(new Uint8Array(cipherBuffer), iv.byteLength);
    
    return combined.buffer;
}

export async function decryptFileBuffer(keys: CryptoKey[], buffer: ArrayBuffer): Promise<{ fileName: string, fileData: ArrayBuffer }> {
    logInfo(`Decrypting file buffer of size: ${buffer.byteLength} bytes`);
    
    const iv = buffer.slice(0, 12);
    const data = buffer.slice(12);

    for (const key of keys) {
        try {
            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: new Uint8Array(iv) },
                key,
                data
            );
            
            const decArray = new Uint8Array(decryptedBuffer);
            const nameLength = decArray[0]; 
            const nameBytes = decArray.slice(1, 1 + nameLength);
            
            const decoder = new TextDecoder();
            const originalName = decoder.decode(nameBytes);
            
            const actualFileData = decArray.slice(1 + nameLength).buffer;

            return { fileName: originalName, fileData: actualFileData };
        } catch (e) {
            continue;
        }
    }
    
    throw new Error("No matching key found for file decryption.");
}

// --- HELPER FUNCTIONS ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

export const ZW_CHARS = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
export const STEGO_MARKER = ZW_CHARS[0] + ZW_CHARS[1] + ZW_CHARS[2] + ZW_CHARS[3];

export function encodeStego(b64Str: string): string {
    let stego = STEGO_MARKER;
    for (let i = 0; i < b64Str.length; i++) {
        let code = b64Str.charCodeAt(i);
        stego += ZW_CHARS[(code >> 6) & 3] + ZW_CHARS[(code >> 4) & 3] + ZW_CHARS[(code >> 2) & 3] + ZW_CHARS[code & 3];
    }
    return stego;
}

export function decodeStego(text: string): { visibleText: string, secretB64: string } | null {
    let idx = text.indexOf(STEGO_MARKER);
    if (idx === -1) return null;

    let stego = text.substring(idx + 4);
    let b64 = "";
    let currentCode = 0;
    let count = 0;

    for (let i = 0; i < stego.length; i++) {
        let val = ZW_CHARS.indexOf(stego[i]);
        if (val === -1) continue; 
        currentCode = (currentCode << 2) | val;
        count++;
        if (count === 4) {
            b64 += String.fromCharCode(currentCode);
            currentCode = 0;
            count = 0;
        }
    }
    return { visibleText: text.substring(0, idx).trim(), secretB64: b64 };
}