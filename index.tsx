/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin, { OptionType, IconComponent } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import * as DataStore from "@api/DataStore";
import { FluxDispatcher, React, useState, useEffect, UploadManager, StreamerModeStore, Toasts, showToast, Button, MessageActions, ComponentDispatch } from "@webpack/common";
import { getCurrentChannel } from "@utils/discord";

import { deriveKey, encryptText, decryptText, encryptFileBuffer, decryptFileBuffer, encodeStego, decodeStego, logInfo, logError } from "./crypto-utils";

// --- SETTINGS ---
const settings = definePluginSettings({
    masterPassword: {
        type: OptionType.STRING,
        description: "Your active shared password for encrypting new messages. (Requires Restart)",
        default: "CHANGE_ME",
        restartNeeded: true
    },
    cryptoSalt: {
        type: OptionType.STRING,
        description: "Salt Customization. This MUST be exactly the same for everyone in your group! (Requires Restart)",
        default: "EncryptionMasterSalt_MakeThisUnique!",
        restartNeeded: true
    },
    legacyPasswords: {
        type: OptionType.STRING,
        description: "Old passwords separated by commas (e.g. oldpass1, oldpass2). Used to decrypt older messages. (Requires Restart)",
        default: "",
        restartNeeded: true
    },
    indicatorStyle: {
        type: OptionType.SELECT,
        description: "How should decrypted messages be marked in chat?",
        options: [
            { label: "Prefix: **[🔒]** Message", value: "prefix", default: true },
            { label: "Emoji: 🔒 Message", value: "emoji" },
            { label: "Spy: 🕵️ Message", value: "spy" },
            { label: "Stealth: (Looks like normal text)", value: "stealth" }
        ]
    },
    hideInStreamerMode: {
        type: OptionType.BOOLEAN,
        description: "Hide decrypted text and files when Discord's Streamer Mode is active.",
        default: true
    },
    hoverToReveal: {
        type: OptionType.BOOLEAN,
        description: "Wrap decrypted messages in Spoiler tags so they must be clicked to read.",
        default: false
    },
    wipeMemory: {
        type: OptionType.COMPONENT,
        description: "Clear the saved ON/OFF toggle states for ALL channels at once.",
        component: () => (
            <div style={{ marginTop: "16px", marginBottom: "16px" }}>
                <Button
                    color={Button.Colors.RED}
                    onClick={async () => {
                        const activeChannels: string[] = (await DataStore.get("enc_master_active_channels")) || [];
                        for (const id of activeChannels) {
                            await DataStore.set(`enc_master_${id}`, false);
                        }
                        await DataStore.set("enc_master_active_channels", []);
                        showToast("Encryption memory wiped for all channels!", Toasts.Type.SUCCESS);
                    }}
                >
                    Wipe All Channel Memory
                </Button>
            </div>
        )
    }
});

let activeKey: CryptoKey | null = null;
let allKeys: CryptoKey[] = [];

let preSendListener: MessageSendListener | null = null;
let streamerModeListener: (() => void) | null = null;
let originalEditMessage: any = null;

function cleanOutgoingText(text: string): string {
    let clean = text;
    const stego = decodeStego(clean);
    if (stego) clean = stego.visibleText; 
    return cleanEditBoxText(clean); 
}

function cleanEditBoxText(text: string): string {
    let clean = text;
    const stego = decodeStego(clean);
    if (stego) return stego.visibleText;

    clean = clean.replace(/\*\*\[🔒\]\*\* \*Encrypted message hidden \(Streamer Mode\)\*/, '');
    clean = clean.replace(/^\*\*\[🔒\]\*\*\s*/, '');
    clean = clean.replace(/^🔒\s*/, '');
    clean = clean.replace(/^🕵️\s*/, '');
    
    if (clean.startsWith("||") && clean.endsWith("||")) {
        clean = clean.substring(2, clean.length - 2);
    }
    
    clean = clean.replace(/^⏳ \*Self-Destructs <t:\d+:R>\*\n/, '');
    clean = clean.replace(/^💥 \*\[Message Expired\]\*/, '');
    return clean;
}

const trackedMessages = new Map<string, any>();
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function formatDecryptedText(text: string, isExpired: boolean = false, visibleText: string = ""): string {
    let formatted = "";
    if (StreamerModeStore.enabled && settings.store.hideInStreamerMode) {
        formatted = `**[🔒]** *Encrypted message hidden (Streamer Mode)*`;
        return visibleText ? `${visibleText}\n> ${formatted}` : formatted;
    }

    let finalText = text;
    if (settings.store.hoverToReveal && !isExpired) {
        finalText = `||${text}||`;
    }

    const style = settings.store.indicatorStyle;
    switch (style) {
        case "prefix": formatted = `**[🔒]** ${finalText}`; break;
        case "emoji": formatted = `🔒 ${finalText}`; break;
        case "spy": formatted = `🕵️ ${finalText}`; break;
        case "stealth": formatted = finalText; break;
        default: formatted = `**[🔒]** ${finalText}`; break;
    }

    if (visibleText) {
        return `${visibleText}\n> ${formatted}`;
    }
    return formatted;
}

async function processDecryptedMessage(message: any) {
    let decrypted = await decryptText(allKeys, message.__emenc_raw);
    let isExpired = false;

    const expMatch = decrypted.match(/^\[EXP:(\d+)\]([\s\S]*)/);
    if (expMatch) {
        const expireAt = parseInt(expMatch[1]);
        if (Date.now() > expireAt) {
            decrypted = "💥 *[Message Expired]*";
            isExpired = true;
        } else {
            decrypted = `⏳ *Self-Destructs <t:${Math.floor(expireAt / 1000)}:R>*\n${expMatch[2]}`;
            const timeLeft = expireAt - Date.now();
            if (timeLeft > 0 && timeLeft <= 2147483647) {
                setTimeout(() => {
                    message.content = message.__emenc_raw_full || message.__emenc_raw;
                    FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message });
                }, timeLeft + 500); 
            }
        }
    }

    message.content = formatDecryptedText(decrypted, isExpired, message.__emenc_visible);
    FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message });
}

// --- FILE INTERCEPTORS ---
async function handleFiles(files: FileList | null, e: Event) {
    if (!files || files.length === 0 || !activeKey) return;
    
    const channelId = getCurrentChannel()?.id;
    if (!channelId) return;

    const isEnabled = await DataStore.get(`enc_master_${channelId}`);
    if (!isEnabled) return; 

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    try {
        UploadManager.clearAll(channelId, 0); 
    } catch (err) {
        logError("Failed to clear native upload manager", err);
    }

    const encryptedFilesToUpload = [];

    for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_SIZE) {
            showToast(`[Encryption Master] Skipping ${file.name}: Exceeds 10MB limit.`, Toasts.Type.FAILURE);
            continue;
        }

        try {
            logInfo(`Intercepted file: ${file.name}. Encrypting...`);
            const buffer = await file.arrayBuffer();
            
            const encryptedBuffer = await encryptFileBuffer(activeKey, buffer, file.name);
            
            const newName = `encrypted_attachment.emd`;
            const newFile = new File([encryptedBuffer], newName, { type: "application/octet-stream" });
            
            encryptedFilesToUpload.push({ file: newFile, platform: 1 });
            logInfo(`Successfully encrypted and packaged ${file.name}`);
        } catch (err) {
            logError(`Failed to encrypt file ${file.name}`, err);
        }
    }

    if (encryptedFilesToUpload.length > 0) {
        UploadManager.addFiles({
            channelId,
            draftType: 0, 
            files: encryptedFilesToUpload
        });
        showToast(`[Encryption Master] Encrypted ${encryptedFilesToUpload.length} file(s) for upload!`, Toasts.Type.SUCCESS);
    }
}

async function handlePaste(e: ClipboardEvent) {
    await handleFiles(e.clipboardData?.files || null, e);
}

async function handleDrop(e: DragEvent) {
    await handleFiles(e.dataTransfer?.files || null, e);
}

function DecryptEMDButton({ message }: { message: any }) {
    const [status, setStatus] = useState<'idle' | 'decrypting' | 'success' | 'error'>('idle');
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const hasEmd = message.attachments?.some((a: any) => a.filename?.endsWith('.emd')) || message.content?.includes('.emd');

    if (!hasEmd || allKeys.length === 0) return null;

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setStatus('decrypting');

        try {
            const buffer = await file.arrayBuffer();
            
            const { fileName, fileData } = await decryptFileBuffer(allKeys, buffer);
            
            const blob = new Blob([fileData]);
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName; 
            a.click();
            URL.revokeObjectURL(url);
            
            setStatus('success');
            setTimeout(() => {
                setStatus('idle');
                if (fileInputRef.current) fileInputRef.current.value = ''; 
            }, 4000);

        } catch (err) {
            logError("File decryption failed", err);
            setStatus('error');
            setTimeout(() => {
                setStatus('idle');
                if (fileInputRef.current) fileInputRef.current.value = ''; 
            }, 4000);
        }
    };

    const getBtnText = () => {
        if (status === 'decrypting') return 'Decrypting...';
        if (status === 'success') return '✅ Saved to Downloads';
        if (status === 'error') return '❌ Incorrect Password or Corrupt File';
        return '🔓 Decrypt Downloaded File (.EMD)';
    };

    const getBtnColor = () => {
        if (status === 'decrypting') return Button.Colors.YELLOW;
        if (status === 'error') return Button.Colors.RED;
        return Button.Colors.GREEN;
    };

    return (
        <div style={{ marginTop: "6px", display: "flex", width: "100%", maxWidth: "400px", gap: "8px" }}>
            <input
                type="file"
                accept=".emd"
                style={{ display: "none" }}
                ref={fileInputRef}
                onChange={handleFileChange}
            />
            <Button
                color={getBtnColor()}
                size={Button.Sizes.SMALL}
                onClick={() => fileInputRef.current?.click()}
                style={{ width: "100%" }}
            >
                {getBtnText()}
            </Button>
        </div>
    );
}

// --- CHAT BAR TOGGLE ---
const EncryptionIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg width={width} height={height} className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 9V7A5 5 0 0 0 7 7V9H5V7A7 7 0 0 1 19 7V9a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h12Zm-5 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
    </svg>
);

const ChatBarToggle: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    const [enabled, setEnabled] = useState(false);
    const channelId = channel.id;

    useEffect(() => {
        if (!channelId) return;
        DataStore.get(`enc_master_${channelId}`).then(state => {
            setEnabled(!!state);
        });
    }, [channelId]);

    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip={enabled ? "Encryption: ON (Drag & Drop files to encrypt them!)" : "Encryption: OFF (Right Click for Steganography Example!)"}
            onClick={async () => {
                const newState = !enabled;
                setEnabled(newState);
                if (channelId) {
                    await DataStore.set(`enc_master_${channelId}`, newState);

                    let active: string[] = (await DataStore.get("enc_master_active_channels")) || [];
                    if (newState) {
                        if (!active.includes(channelId)) active.push(channelId);
                    } else {
                        active = active.filter((id: string) => id !== channelId);
                    }
                    await DataStore.set("enc_master_active_channels", active);
                }
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                try {
                    ComponentDispatch.dispatchToLastSubscribed("INSERT_TEXT", { plainText: '{YOUR PUBLIC MESSAGE HERE | YOUR SECRET MESSAGE HERE}' });
                } catch(err) {
                    logError("Failed to insert text template", err);
                }
            }}
            buttonProps={{
                style: {
                    transition: "transform 0.2s ease, color 0.2s ease",
                    transform: `scale(${enabled ? 1.1 : 1})`,
                    color: enabled ? "#43b581" : "#b5bac1"
                }
            }}
        >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                {enabled ? (
                    <path d="M17 9V7A5 5 0 0 0 7 7V9a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7a3 3 0 0 0-3-3ZM9 7a3 3 0 1 1 6 0v2H9V7Zm3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" />
                ) : (
                    <path d="M17 9V7A5 5 0 0 0 7 7V9H5V7A7 7 0 0 1 19 7V9a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h12Zm-5 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                )}
            </svg>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "Encryption Master",
    description: "Symmetric AES-GCM encryption. V1.0.0",
    authors: [{ name: "Parker7680", id: "551087715463069698" }],
    dependencies: ["ChatInputButtonAPI", "CommandsAPI", "MessageAccessoriesAPI"],
    settings,
    
    chatBarButton: {
        icon: EncryptionIcon,
        render: ChatBarToggle
    },

    renderMessageAccessory: (props: Record<string, any>) => {
        return <DecryptEMDButton message={props.message} />;
    },

    // --- FLUX DISPATCHER ---
    flux: {
        async MESSAGE_CREATE(event) {
            const message = event.message;
            if (allKeys.length === 0 || typeof message?.content !== "string") return;

            const stego = decodeStego(message.content);
            if (stego && stego.secretB64.startsWith("[EMENC]")) {
                message.__emenc_raw_full = message.content;
                message.__emenc_raw = stego.secretB64;
                message.__emenc_visible = stego.visibleText;
                trackedMessages.set(message.id, message);
                processDecryptedMessage(message);
            } 
            else if (message.content.startsWith("[EMENC]")) {
                message.__emenc_raw = message.content;
                message.__emenc_visible = "";
                trackedMessages.set(message.id, message);
                processDecryptedMessage(message);
            }
        },

        async MESSAGE_UPDATE(event) {
            const message = event.message;
            if (allKeys.length === 0 || typeof message?.content !== "string") return;

            const stego = decodeStego(message.content);
            if (stego && stego.secretB64.startsWith("[EMENC]")) {
                message.__emenc_raw_full = message.content;
                message.__emenc_raw = stego.secretB64;
                message.__emenc_visible = stego.visibleText;
                trackedMessages.set(message.id, message);
                processDecryptedMessage(message);
            } else if (message.content.startsWith("[EMENC]")) {
                message.__emenc_raw = message.content;
                message.__emenc_visible = "";
                trackedMessages.set(message.id, message);
                processDecryptedMessage(message);
            }
        },

        async MESSAGE_START_EDIT(event) {
            if (event.content && trackedMessages.has(event.messageId)) {
                event.content = cleanEditBoxText(event.content);
            }
        },

        async LOAD_MESSAGES_SUCCESS(event) {
            if (allKeys.length === 0) return;
            
            for (const message of event.messages) {
                if (typeof message.content === "string") {
                    const stego = decodeStego(message.content);
                    if (stego && stego.secretB64.startsWith("[EMENC]")) {
                        message.__emenc_raw_full = message.content;
                        message.__emenc_raw = stego.secretB64;
                        message.__emenc_visible = stego.visibleText;
                        trackedMessages.set(message.id, message);
                        processDecryptedMessage(message);
                    } else if (message.content.startsWith("[EMENC]")) {
                        message.__emenc_raw = message.content;
                        message.__emenc_visible = "";
                        trackedMessages.set(message.id, message);
                        processDecryptedMessage(message);
                    }
                }
            }
        }
    },

    // --- PLUGIN LIFECYCLE & SENDER ---
    async start() {
        logInfo("Plugin starting...");

        document.addEventListener("paste", handlePaste, { capture: true });
        document.addEventListener("drop", handleDrop, { capture: true });

        streamerModeListener = async () => {
            if (allKeys.length === 0) return;
            for (const [id, message] of trackedMessages.entries()) {
                if (message.__emenc_raw) {
                    processDecryptedMessage(message);
                }
            }
        };
        StreamerModeStore.addChangeListener(streamerModeListener);

        try {
            const rawPassword = settings.store.masterPassword;
            const passwordToUse = rawPassword.replace(/,/g, "");
            const saltToUse = settings.store.cryptoSalt;
            
            if (rawPassword.includes(",")) {
                logInfo("Notice: Commas were automatically removed from your Master Password.");
            }

            activeKey = await deriveKey(passwordToUse, saltToUse);
            allKeys = [activeKey];

            const legacyInput = settings.store.legacyPasswords;
            if (legacyInput && legacyInput.trim().length > 0) {
                const oldPasswords = legacyInput.split(',').map(p => p.trim()).filter(p => p.length > 0);
                for (const oldPass of oldPasswords) {
                    try {
                        const oldKey = await deriveKey(oldPass, saltToUse);
                        allKeys.push(oldKey);
                    } catch(e) {
                        logError(`Failed to derive legacy key for a password`, e);
                    }
                }
            }
            logInfo(`Session keys established. Active: 1, Legacy: ${allKeys.length - 1}`);
        } catch (error) {
            logError("CRITICAL: Failed to generate active session key.", error);
            return;
        }

        preSendListener = async (_, message) => {
            if (!activeKey) return;
            
            const channelId = getCurrentChannel()?.id;
            if (!channelId) return;

            const text = message.content.trim();
            const isEnabled = await DataStore.get(`enc_master_${channelId}`);
            
            let shouldEncrypt = isEnabled;
            let rawMessage = text;

            if (text.startsWith("/enc ")) {
                shouldEncrypt = true;
                rawMessage = text.substring(5).trim();
            }

            if (shouldEncrypt && rawMessage.length > 0) {
                logInfo("Encryption active. Intercepting message...");
                
                try {
                    const expMatch = rawMessage.match(/^"(\d+)([smhd])"\s+([\s\S]*)/i);
                    let expireAt = 0;
                    let payloadText = rawMessage;

                    if (expMatch) {
                        const val = parseInt(expMatch[1]);
                        const unit = expMatch[2].toLowerCase();
                        let multiplier = 1000;
                        if (unit === 'm') multiplier = 60 * 1000;
                        if (unit === 'h') multiplier = 60 * 60 * 1000;
                        if (unit === 'd') multiplier = 24 * 60 * 60 * 1000;
                        expireAt = Date.now() + (val * multiplier);
                        payloadText = expMatch[3];
                    }

                    const stegoMatch = payloadText.match(/^\{([\s\S]+?)\|([\s\S]+?)\}$/);
                    let visibleText = "";
                    let secretText = payloadText;

                    if (stegoMatch) {
                        visibleText = stegoMatch[1].trim();
                        secretText = stegoMatch[2].trim();
                    }

                    if (expireAt > 0) {
                        secretText = `[EXP:${expireAt}]${secretText}`;
                    }

                    const encryptedString = await encryptText(activeKey, secretText);

                    if (stegoMatch) {
                        const invisibleString = encodeStego(encryptedString);
                        message.content = `${visibleText} ${invisibleString}`; 
                        logInfo("Steganography message encrypted successfully.");
                    } else {
                        message.content = encryptedString;
                        logInfo("Standard message encrypted successfully.");
                    }

                } catch (error) {
                    logError("Encryption failed.", error);
                    message.content = "⚠️ [Encryption Master: Internal Error - Aborted]";
                }
            }
        };

        originalEditMessage = MessageActions.editMessage;
        MessageActions.editMessage = async (channelId: string, messageId: string, message: { content: string }) => {
            if (activeKey && message && typeof message.content === "string") {
                
                const text = cleanOutgoingText(message.content.trim());
                
                const isEnabled = await DataStore.get(`enc_master_${channelId}`);
                let shouldEncrypt = isEnabled;
                let rawMessage = text;

                if (text.startsWith("/enc ")) {
                    shouldEncrypt = true;
                    rawMessage = text.substring(5).trim();
                }

                if (trackedMessages.has(messageId)) {
                    shouldEncrypt = true; 
                }

                if (shouldEncrypt && rawMessage.length > 0) {
                    logInfo("Encrypting edited message...");
                    try {
                        const expMatch = rawMessage.match(/^"(\d+)([smhd])"\s+([\s\S]*)/i);
                        if (expMatch) {
                            const val = parseInt(expMatch[1]);
                            const unit = expMatch[2].toLowerCase();
                            let multiplier = 1000;
                            if (unit === 'm') multiplier = 60 * 1000;
                            if (unit === 'h') multiplier = 60 * 60 * 1000;
                            if (unit === 'd') multiplier = 24 * 60 * 60 * 1000;
                            const expireAt = Date.now() + (val * multiplier);
                            rawMessage = `[EXP:${expireAt}]${expMatch[3]}`;
                        }

                        const encryptedString = await encryptText(activeKey, rawMessage);
                        message.content = encryptedString;
                        logInfo("Edited message encrypted successfully.");
                    } catch (error) {
                        logError("Encryption failed on edit.", error);
                    }
                }
            }
            return originalEditMessage.call(MessageActions, channelId, messageId, message);
        };

        addMessagePreSendListener(preSendListener);
    },

    async stop() {
        logInfo("Plugin stopping...");
        
        document.removeEventListener("paste", handlePaste, { capture: true });
        document.removeEventListener("drop", handleDrop, { capture: true });
        
        if (streamerModeListener) StreamerModeStore.removeChangeListener(streamerModeListener);
        if (preSendListener) removeMessagePreSendListener(preSendListener);
        if (originalEditMessage) {
            MessageActions.editMessage = originalEditMessage;
            originalEditMessage = null;
        }
        
        activeKey = null;
        allKeys = [];
        trackedMessages.clear();
    }
});