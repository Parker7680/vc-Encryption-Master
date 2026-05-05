# Encryption Master

A simple Plugin to encrypt and decrypt messages in discord for you and your friends

## Features
* AES-GCM Encryption
* File Encryption
* Zero-Width Steganography
* Timed Messages
* Hover to Reveal decrypted message
* Streamer Mode Hiding
* Legacy Passwords

---

## Installation

This plugin must be installed through Vencord's custom plugin system. 

Follow the Vencord guide here: [How to Install Custom Plugins](https://docs.vencord.dev/installing/custom-plugins/)

Then you can clone this repository directly into your `vencord/src/userplugins/` directory and you can Enable **Encryption Master** in your Vencord Plugins.

*You can also check out [This discord Message](https://discord.com/channels/1015060230222131221/1257038407503446176) on the vencord discord server*

> [!IMPORTANT]
> Change the default password and salt in the Plugin Settings to one that you and your group decide on

---

## How to Use

Click the **Lock Icon** in your chat bar to toggle encryption ON (Green) or OFF (white) for the current channel. 

there are also many features that you can use when formatting your messages:

### 1. The Single-Message Override
If you want to send a quick encrypted message without clicking the toggle, simply start your message with `/enc `:
> `/enc This message will be encrypted.` 

> *A little note with this is that it doesn't use discords / commands because that is slower than just typing it.*

### 2. Zero-Width Steganography (Invisible Message)
You can hide your encrypted message inside the invisible spaces of a normal sentence! Anyone without the plugin will only see the normal text. 
Format your message using brackets and a pipe `|`:
> `{Hey guys, just normal chat! | This is a secret message only you can see.}` 

> *You can Right-Click the Encryption Master icon in the chat bar to instantly paste this template into your chat box!*

### 3. Timed Messages
You can set a timer on your messages. And Once the time hits zero, the message will not decrypt anymore.
Format the beginning of your message with quotes and a time code (`s` for seconds, `m` for minutes, `h` for hours, `d` for days):
> `"5m" This message will be gone in 5 minutes.`

> `/enc "1h" {Cover text | Secret text that disappears in an hour}`

> This Doesn't make decryption impossible but more of the script wont decrypt it.

### 4. File Encryption
1. Turn the Encryption Toggle **ON (Green)**.
2. Drag and drop any file (10MB limit for now) into Discord, or paste an image.
3. The plugin will intercept it, encrypt the raw bytes, rename it to `.emd`, and upload it.
4. When your friend receives it, a green **"🔓 Decrypt Downloaded File"** button will appear below it. They must download the file normally via Discord, then click the green button to upload the file and decrypt it back to its original format.
> I dont like the long process either but its the best that i could come up with and will probably change later.

### 5. Legacy Passwords / Changing your Password
If your group decides to change your Master Password, you don't want to lose access to your old chat history. 
1. Go to Vencord Settings -> Encryption Master.
2. Put your *new* password in the **Master Password** box.
3. Put your *old* password in the **Legacy Passwords** box. (You can add multiple old passwords separated by commas: `oldpass1, oldpass2`).
4. Restart Discord. Your plugin will now encrypt *new* messages with the new password, and will check the legacy list to decrypt old messages.
> Also Don't use comma's in your Master Password. it will still work but they are the seperator for the Legacy Password input box. so any commas will be automaticly removed.

### 6. Custom Crypto Salt
By default, the plugin uses a standard Salt to generate your keys. If you want to make your encryption mathematically unique to your specific group, you can change the Salt.

1. Go to Vencord Settings -> Encryption Master.
2. Change the **Crypto Salt** setting to a random string of text *(at least 16 characters)*
> Every single person in your group **MUST** have the exact same Master Password AND the exact same Crypto Salt. If even one letter or space is different, the decryption will fail!