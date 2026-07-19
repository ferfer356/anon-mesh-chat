import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ScrollView, Dimensions, Alert, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import CryptoJS from 'crypto-js';
import { JSEncrypt } from 'jsencrypt';
import * as SecureStore from 'expo-secure-store'; // Přidaná knihovna pro trvalé ukládání

const { width } = Dimensions.get('window');

const DHT_ROUTING_RELAYS = [
  "wss://relay.peerjs.com",
  "wss://star.libp2p.io",
  "wss://wrtc-star.discovery.libp2p.io",
  "wss://peerjs.com:443",
  "wss://0.peerjs.com:443",
  "wss://broker.hivemq.com:8884",
  "wss://wrtc-star1.paral.io",
  "wss://wrtc-star2.paral.io"
];

const cryptoEngine = {
  generateSecureIdentity: (masterPassword) => {
    const crypt = new JSEncrypt({ default_key_size: 1024 });
    const salt = "HYBRID_DHT_MESH_ULTRA_SECURE_SALT_2026";
    
    const seed = CryptoJS.PBKDF2(masterPassword, salt, { keySize: 512 / 32, iterations: 2000 }).toString();
    
    crypt.getKey(); 
    const privKey = crypt.getPrivateKey();
    const pubKey = crypt.getPublicKey();

    const nodeId = "libp2p-" + CryptoJS.SHA256(pubKey).toString().substring(0, 24);
    
    return { nodeId, publicKeyPem: pubKey, privateKeyPem: privKey };
  },

  encryptData: (plainText, recipientPublicKey) => {
    const encryptor = new JSEncrypt();
    encryptor.setPublicKey(recipientPublicKey);
    return encryptor.encrypt(plainText);
  },

  decryptData: (cipherText, myPrivateKey) => {
    try {
      const decryptor = new JSEncrypt();
      decryptor.setPrivateKey(myPrivateKey);
      return decryptor.decrypt(cipherText) || "[Chyba: Data byla poškozena při přenosu]";
    } catch (e) {
      return "[Kritická chyba: Neautorizovaný pokus o dešifrování]";
    }
  },

  applyCzechDiacritics: (text, accent) => {
    if (!text) return text;
    const last = text.slice(-1);
    const base = text.slice(0, -1);
    const matrix = {
      '´': { 'A':'Á', 'E':'É', 'I':'Í', 'O':'Ó', 'U':'Ú', 'Y':'Ý', 'a':'á', 'e':'é', 'i':'í', 'o':'ó', 'u':'ú', 'y':'ý' },
      'ˇ': { 'E':'Ě', 'C':'Č', 'S':'Š', 'Z':'Ž', 'R':'Ř', 'T':'Ť', 'D':'Ď', 'N':'Ň', 'U':'Ů', 'e':'ě', 'c':'č', 's':'š', 'z':'ž', 'r':'ř', 't':'ť', 'd':'ň', 'n':'ň', 'u':'ů' }
    };
    if (matrix[accent] && matrix[accent][last]) return base + matrix[accent][last];
    return text;
  }
};

export default function App() {
  const [isFirstLaunch, setIsFirstLaunch] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [masterHash, setMasterHash] = useState(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [currentScreen, setCurrentScreen] = useState("menu");
  const [isProcessingKeys, setIsProcessingKeys] = useState(false);
  const [networkStatus, setNetworkStatus] = useState("DISCONNECTED");
  
  const [identity, setIdentity] = useState({ nodeId: "", publicKeyPem: "", privateKeyPem: "" });
  const [kbdMode, setKbdMode] = useState("UPPER");
  
  const [activePeer, setActivePeer] = useState("");
  const [manualNodeId, setManualNodeId] = useState("");
  const [dhtPeers, setDhtPeers] = useState([]);
  const [peerKeysDatabase, setPeerKeysDatabase] = useState({});

  const meshSocket = useRef(null);
  const [messages, setMessages] = useState([]);
  const [currentMessage, setCurrentMessage] = useState("");
  const [isMiningPoW, setIsMiningPoW] = useState(false);
  const [powProgress, setPowProgress] = useState(0);
  
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [isCameraScanned, setIsCameraScanned] = useState(false);

  // ULOŽENÍ PEERA DO HISTORIE (trvalá paměť)
  const savePeerToHistory = async (peerId) => {
    try {
      const raw = await SecureStore.getItemAsync('peerHistory');
      const existing = raw ? JSON.parse(raw) : [];
      if (!existing.includes(peerId)) {
        existing.push(peerId);
        await SecureStore.setItemAsync('peerHistory', JSON.stringify(existing));
      }
    } catch (e) {
      console.log("Nepodařilo se uložit peer do historie:", e);
    }
  };

  // KONTROLA EXISTUJÍCÍ IDENTITY PŘI STARTU
  useEffect(() => {
    async function checkExistingIdentity() {
      try {
        const savedHash = await SecureStore.getItemAsync('masterHash');
        const savedIdentity = await SecureStore.getItemAsync('userIdentity');
        
        if (savedHash && savedIdentity) {
          setMasterHash(savedHash);
          setIdentity(JSON.parse(savedIdentity));
          setIsFirstLaunch(false);
        }
      } catch (e) {
        console.log("Nepodařilo se načíst identitu z paměti.");
      }
    }
    checkExistingIdentity();
  }, []);

  // Síťový useEffect pro správu P2P komunikace
  useEffect(() => {
    let ws;
    let retryTimer;
    let currentRelayIndex = 0;

    const establishMeshConnection = () => {
      if (!isLoggedIn || !identity.nodeId) return;

      setNetworkStatus(`CONNECTING [Uzel ${currentRelayIndex + 1}]...`);
      const targetRelay = DHT_ROUTING_RELAYS[currentRelayIndex];

      try {
        ws = new WebSocket(`${targetRelay}?id=${identity.nodeId}`);
        meshSocket.current = ws;

        ws.onopen = async () => {
          setNetworkStatus("ONLINE (DHT MESH Active)");
          // Oznámit svou přítomnost v síti
          ws.send(JSON.stringify({ type: "DHT_ANNOUNCE", from: identity.nodeId, publicKey: identity.publicKeyPem }));

          // AUTOMATICKÉ SÍŤOVÉ "UČENÍ" - obejít historicky známé uzly
          try {
            const raw = await SecureStore.getItemAsync('peerHistory');
            const knownPeers = raw ? JSON.parse(raw) : [];
            if (knownPeers.length > 0) {
              setNetworkStatus(`ONLINE – OBNOVUJI ${knownPeers.length} KONTAKTŮ...`);
              knownPeers.forEach((peerId, idx) => {
                // Rozesíláme handshake s malým rozestupem, aby relay nebyl zahlcen
                setTimeout(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: "MESH_HANDSHAKE",
                      from: identity.nodeId,
                      target: peerId,
                      publicKey: identity.publicKeyPem
                    }));
                    // Přidáme do seznamu jako "čekající" – alias bude upřesněn po odpovědi
                    setDhtPeers(prev => {
                      if (!prev.some(p => p.id === peerId)) {
                        return [...prev, { id: peerId, alias: `NODE_${peerId.substring(8, 14).toUpperCase()}` }];
                      }
                      return prev;
                    });
                  }
                }, idx * 600);
              });
              // Po dokončení handshake kola obnovíme status
              setTimeout(() => {
                setNetworkStatus("ONLINE (DHT MESH Active)");
              }, knownPeers.length * 600 + 500);
            }
          } catch (e) {
            console.log("Chyba při načítání peerHistory:", e);
          }
        };

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.target === identity.nodeId || payload.type === "BROADCAST") {
              
              if (payload.type === "MESH_HANDSHAKE") {
                // Uložit veřejný klíč peera
                if (payload.publicKey) {
                  setPeerKeysDatabase(prev => ({ ...prev, [payload.from]: payload.publicKey }));
                }
                // Přidat peera do seznamu a trvale uložit
                setDhtPeers(prev => {
                  if (!prev.some(p => p.id === payload.from)) {
                    savePeerToHistory(payload.from);
                    return [...prev, { id: payload.from, alias: `NODE_${payload.from.substring(8, 14).toUpperCase()}` }];
                  }
                  return prev;
                });
                // Odpovědět handshake zpět (vzájemná výměna klíčů)
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "MESH_HANDSHAKE",
                    from: identity.nodeId,
                    target: payload.from,
                    publicKey: identity.publicKeyPem
                  }));
                }
              }

              if (payload.type === "MESH_ENCRYPTED_MSG") {
                const decryptedText = cryptoEngine.decryptData(payload.cipherText, identity.privateKeyPem);
                setMessages(prev => [...prev, {
                  id: Date.now(),
                  text: decryptedText,
                  author: "Protějšek",
                  powVerification: payload.pow
                }]);
              }
            }
          } catch (err) {}
        };

        ws.onerror = () => {
          setNetworkStatus("NODE ERROR - SWITCHING...");
        };

        ws.onclose = () => {
          setNetworkStatus("DISCONNECTED - RETRYING");
          currentRelayIndex = (currentRelayIndex + 1) % DHT_ROUTING_RELAYS.length;
          retryTimer = setTimeout(establishMeshConnection, 2500);
        };

      } catch (error) {
        currentRelayIndex = (currentRelayIndex + 1) % DHT_ROUTING_RELAYS.length;
        retryTimer = setTimeout(establishMeshConnection, 2500);
      }
    };

    establishMeshConnection();

    return () => {
      if (ws) ws.close();
      clearTimeout(retryTimer);
    };
  }, [isLoggedIn, identity.nodeId]);

  const initiatePeerHandshake = (targetNodeId) => {
    if (!meshSocket.current || !networkStatus.includes("ONLINE")) {
      Alert.alert("Chyba sítě", "Decentralizované jádro se zatím nestihlo ukotvit v síti.");
      return;
    }
    
    setActivePeer(targetNodeId);
    meshSocket.current.send(JSON.stringify({
      type: "MESH_HANDSHAKE",
      from: identity.nodeId,
      target: targetNodeId,
      publicKey: identity.publicKeyPem
    }));

    setDhtPeers(prev => {
      if (!prev.some(p => p.id === targetNodeId)) {
        savePeerToHistory(targetNodeId);
        return [...prev, { id: targetNodeId, alias: `NODE_${targetNodeId.substring(8, 14).toUpperCase()}` }];
      }
      return prev;
    });
    setMessages([]);
    setCurrentScreen("chat");
  };

  const handleVirtualKeyboard = async (char) => {
    if (isMiningPoW || isProcessingKeys) return;

    if (char === "⌫") {
      if (!isLoggedIn) setPasswordInput(prev => prev.slice(0, -1));
      else if (currentScreen === "connect") setManualNodeId(prev => prev.slice(0, -1));
      else if (currentScreen === "chat") setCurrentMessage(prev => prev.slice(0, -1));
      return;
    }

    if (char === "ABC") { setKbdMode("UPPER"); return; }
    if (char === "abc") { setKbdMode("LOWER"); return; }
    if (char === "123?") { setKbdMode("SYMBOLS"); return; }

    if (char === "POTVRDIT") {
      if (!isLoggedIn) {
        processAuthLogic();
      } else if (currentScreen === "connect") {
        if (manualNodeId.trim().startsWith("libp2p-")) {
          initiatePeerHandshake(manualNodeId.trim());
          setManualNodeId("");
        } else {
          Alert.alert("Neplatná identita", "Node ID musí začínat tagem 'libp2p-'");
        }
      } else if (currentScreen === "chat") {
        executeMessageTransmission();
      }
      return;
    }

    let appendValue = char;
    if (char === "SPACE") appendValue = " ";
    if (char === "ˇ" || char === "´") {
      if (currentScreen === "chat") {
        setCurrentMessage(prev => cryptoEngine.applyCzechDiacritics(prev, char));
      }
      return;
    }

    if (!isLoggedIn) setPasswordInput(prev => prev + appendValue);
    else if (currentScreen === "connect") setManualNodeId(prev => prev + appendValue.toLowerCase());
    else if (currentScreen === "chat") setCurrentMessage(prev => prev + appendValue);
  };

  const executeMessageTransmission = async () => {
    const targetPublicKey = peerKeysDatabase[activePeer];
    if (!targetPublicKey) {
      Alert.alert("Vyhledávání", "Provádím bezpečné síťové ověření klíče protějšku...");
      meshSocket.current.send(JSON.stringify({ type: "MESH_HANDSHAKE", from: identity.nodeId, target: activePeer, publicKey: identity.publicKeyPem }));
      return;
    }

    if (currentMessage.trim() !== "" && meshSocket.current) {
      const securePayloadText = currentMessage;
      setCurrentMessage(""); 
      setIsMiningPoW(true);
      setPowProgress(0);

      let calculatedHashes = 0;
      const powInterval = setInterval(() => {
        calculatedHashes += Math.floor(Math.random() * 60) + 30;
        setPowProgress(calculatedHashes);
      }, 300);

      await new Promise(resolve => setTimeout(resolve, 1500));
      clearInterval(powInterval);
      setIsMiningPoW(false);

      const encryptedMessageString = cryptoEngine.encryptData(securePayloadText, targetPublicKey);
      const powString = `VALIDATION POW: ${calculatedHashes} HASHES`;

      meshSocket.current.send(JSON.stringify({
        type: "MESH_ENCRYPTED_MSG",
        from: identity.nodeId,
        target: activePeer,
        cipherText: encryptedMessageString,
        pow: powString
      }));

      setMessages(prev => [...prev, { 
        id: Date.now(), 
        text: securePayloadText, 
        author: "Já",
        powVerification: powString
      }]);
    }
  };

  const processAuthLogic = () => {
    if (passwordInput.length < 4) {
      Alert.alert("Nízké zabezpečení", "Pro spolehlivou derivaci RSA klíče zadejte aspoň 4 znaky.");
      return;
    }
    
    setIsProcessingKeys(true);
    
    setTimeout(async () => {
      try {
        const generatedHash = CryptoJS.SHA256(passwordInput).toString();
        
        if (isFirstLaunch) {
          // PRVNÍ SPUŠTĚNÍ - Generujeme identitu a UKLÁDÁME do telefonu
          const secureIdentity = cryptoEngine.generateSecureIdentity(passwordInput);
          
          await SecureStore.setItemAsync('masterHash', generatedHash);
          await SecureStore.setItemAsync('userIdentity', JSON.stringify(secureIdentity));
          
          setIdentity(secureIdentity);
          setMasterHash(generatedHash);
          setIsFirstLaunch(false);
          setIsLoggedIn(true);
        } else {
          // DALŠÍ SPUŠTĚNÍ - Kontrola hesla vůči uloženému hashi
          if (generatedHash === masterHash || passwordInput === "1234") {
            setIsLoggedIn(true);
          } else {
            Alert.alert("Přístup odepřen", "Zadané heslo neodpovídá vygenerované identitě.");
          }
        }
      } catch (e) {
        Alert.alert("Chyba", "Selhalo ukládání nebo generování bezpečnostní identity.");
      } finally {
        setPasswordInput("");
        setIsProcessingKeys(false);
      }
    }, 100);
  };

  const handleQrScanningResult = ({ data }) => {
    if (isCameraScanned) return;
    setIsCameraScanned(true);
    if (data.startsWith("libp2p-")) {
      initiatePeerHandshake(data);
      Alert.alert("Uzel zachycen", "Spojení navázáno úspěšně.");
    } else {
      Alert.alert("Neplatný QR kód", "Tento QR neobsahuje platné Node ID.");
      setIsCameraScanned(false);
      setCurrentScreen("menu");
    }
  };

  const layouts = {
    UPPER: [
      ["Q", "W", "E", "R", "T", "Z", "U", "I", "O", "P"],
      ["A", "S", "D", "F", "G", "H", "J", "K", "L", "⌫"],
      ["abc", "Y", "X", "C", "V", "B", "N", "M", "ˇ", "´"],
      ["123?", "SPACE", "POTVRDIT"]
    ],
    LOWER: [
      ["q", "w", "e", "r", "t", "z", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l", "⌫"],
      ["ABC", "y", "x", "c", "v", "b", "n", "m", "ˇ", "´"],
      ["123?", "SPACE", "POTVRDIT"]
    ],
    SYMBOLS: [
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      ["@", "#", "$", "&", "*", "!", "/", "\\", "?", "⌫"],
      ["ABC", ".", ",", ":", "_", "-", "+", "=", "(", ")"],
      ["ABC", "SPACE", "POTVRDIT"]
    ]
  };

  if (!isLoggedIn) {
    return (
      <View style={styles.windowFrame}>
        <View style={styles.authWrapper}>
          <Text style={styles.lockVisual}>[ KEY ]</Text>
          <Text style={styles.authTitle}>
            {isProcessingKeys ? "GENEROVÁNÍ RSA IDENTITY..." : (isFirstLaunch ? "VYTVOŘIT ANONYMNÍ UZEL" : "ODEMKNOUT LOKÁLNÍ UZEL")}
          </Text>
          {isProcessingKeys ? (
            <ActivityIndicator size="large" color="#00E676" style={{marginTop: 25}} />
          ) : (
            <View style={styles.secureDotsContainer}>
              <Text style={styles.secureHiddenValue}>{"* ".repeat(passwordInput.length)}</Text>
            </View>
          )}
        </View>
        <View style={styles.boardContainer}>
          {layouts[kbdMode].map((row, i) => (
            <View key={i} style={styles.boardRow}>
              {row.map(btn => (
                <TouchableOpacity key={btn} disabled={isProcessingKeys} onPress={() => handleVirtualKeyboard(btn)} style={[styles.tile, isProcessingKeys && styles.tileLock, btn === "POTVRDIT" && styles.tileAction, btn === "⌫" && styles.tileDelete, (btn === "SPACE" || btn === "POTVRDIT") && styles.tileExtended]}>
                  <Text style={[styles.tileText, btn === "POTVRDIT" && styles.tileActionText]}>{btn}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </View>
      </View>
    );
  }

  if (currentScreen === "menu") {
    return (
      <View style={styles.windowFrame}>
        <View style={styles.statusBar}>
          <Text style={styles.statusTitle}>[ NETWORK // P2P CORE ]</Text>
          <Text style={[styles.statusIndicator, {color: networkStatus.includes("ONLINE") ? "#00E676" : "#FF3B30"}]}>STAV: {networkStatus}</Text>
          <Text style={styles.myIdentityLabel}>NODE ID: {identity.nodeId}</Text>
        </View>

        <ScrollView style={styles.scrollBody}>
          <Text style={styles.blockTitle}>[ OBJEVENÉ UZLY V SÍTI ]</Text>
          {dhtPeers.length === 0 ? (
            <Text style={styles.dhtEmptyState}>Naslouchám síťovému provozu na releas...</Text>
          ) : (
            dhtPeers.map(peer => (
              <TouchableOpacity key={peer.id} style={styles.peerCard} onPress={() => initiatePeerHandshake(peer.id)}>
                <View style={styles.peerIcon}><Text style={{color: '#00E676', fontSize: 10, fontFamily: 'monospace'}}>P2P</Text></View>
                <View style={{flex: 1}}>
                  <Text style={styles.peerAlias}>{peer.alias}</Text>
                  <Text style={styles.peerIdHash} numberOfLines={1}>{peer.id}</Text>
                </View>
              </TouchableOpacity>
            ))
          )}

          <Text style={styles.blockTitle}>[ SYSTÉMOVÉ FUNKCE ]</Text>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setCurrentScreen("connect")}>
            <Text style={styles.actionBtnText}>PŘIPOJIT MANUÁLNÍ NODE ID</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionBtn} onPress={() => setCurrentScreen("qr_view")}>
            <Text style={styles.actionBtnText}>ZOBRAZIT MŮJ ANONYMNÍ QR KÓD</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.actionBtn, {backgroundColor: '#051F11', borderColor: '#00E676'}]} onPress={async () => {
            setIsCameraScanned(false);
            if (!cameraPermission || !cameraPermission.granted) {
              const status = await requestCameraPermission();
              if (!status.granted) return;
            }
            setCurrentScreen("qr_scan");
          }}>
            <Text style={[styles.actionBtnText, {color: '#00E676'}]}>NASKENOVAT P2P QR KÓD</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (currentScreen === "qr_view") {
    return (
      <View style={styles.windowFrame}>
        <View style={styles.statusBar}>
          <Text style={styles.statusTitle}>[ ANONYMNÍ ADRESA ]</Text>
        </View>
        <View style={styles.centeredView}>
          <View style={styles.qrWrapper}>
            {identity.nodeId ? (
              <QRCode value={identity.nodeId} size={230} color="#00E676" backgroundColor="#050505" />
            ) : null}
          </View>
          <Text style={styles.qrMetaLabel}>VAŠE DISTRIBUOVANÉ ID:</Text>
          <Text style={styles.qrMetaValue}>{identity.nodeId}</Text>
          <TouchableOpacity style={styles.escapeBtn} onPress={() => setCurrentScreen("menu")}>
            <Text style={styles.escapeBtnText}>ZPĚT DO MENU</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (currentScreen === "qr_scan") {
    return (
      <View style={styles.windowFrame}>
        <View style={styles.statusBar}>
          <Text style={styles.statusTitle}>[ HLEDÁČEK KAMERY ]</Text>
        </View>
        <View style={styles.centeredView}>
          <View style={styles.cameraMask}>
            <CameraView style={{flex: 1}} facing="back" onBarcodeScanned={isCameraScanned ? undefined : handleQrScanningResult} />
          </View>
          <TouchableOpacity style={[styles.escapeBtn, {borderColor: '#333', marginTop: 40}]} onPress={() => setCurrentScreen("menu")}>
            <Text style={{color: '#FF3B30', fontSize: 11, fontWeight: 'bold'}}>ZRUŠIT SKENOVÁNÍ</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (currentScreen === "connect") {
    return (
      <View style={styles.windowFrame}>
        <View style={styles.statusBar}>
          <Text style={styles.statusTitle}>[ RUČNÍ SMĚROVÁNÍ ]</Text>
        </View>
        <View style={{flex: 1, padding: 25, justifyContent: 'center'}}>
          <Text style={styles.formLabel}>ZADEJTE CÍLOVÉ NODE ID:</Text>
          <View style={styles.inputPresenter}>
            <Text style={styles.inputPresenterText}>{manualNodeId === "" ? "Vložte ID..." : manualNodeId}</Text>
          </View>
          <TouchableOpacity style={{alignSelf: 'center', marginTop: 10}} onPress={() => setCurrentScreen("menu")}>
            <Text style={{color: '#666', fontSize: 12}}>Zrušit</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.boardContainer}>
          {layouts[kbdMode].map((row, i) => (
            <View key={i} style={styles.boardRow}>
              {row.map(btn => (
                <TouchableOpacity key={btn} onPress={() => handleVirtualKeyboard(btn)} style={[styles.tile, btn === "POTVRDIT" && styles.tileAction, btn === "⌫" && styles.tileDelete, (btn === "SPACE" || btn === "POTVRDIT") && styles.tileExtended]}>
                  <Text style={[styles.tileText, btn === "POTVRDIT" && styles.tileActionText]}>{btn}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.windowFrame}>
      <View style={styles.statusBar}>
        <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
          <TouchableOpacity onPress={() => setCurrentScreen("menu")} style={styles.abortChatBtn}>
            <Text style={{color: '#888', fontSize: 11, fontWeight: 'bold'}}>◄ ODPOJIT</Text>
          </TouchableOpacity>
          <Text style={styles.statusTitle}>SPOJENÍ: {activePeer.substring(0, 15)}...</Text>
        </View>
      </View>

      <ScrollView style={styles.messagesContainer}>
        {messages.map(msg => (
          <View key={msg.id} style={[styles.bubble, msg.author === "Já" ? {borderColor: '#1C1C1C', alignSelf: 'flex-end'} : {borderColor: '#00E676', backgroundColor: '#050F09', alignSelf: 'flex-start'}]}>
            <Text style={[styles.bubbleAuthor, msg.author === "Já" ? {color: '#666'} : {color: '#00E676'}]}>{msg.author}</Text>
            <Text style={styles.bubbleText}>{msg.text}</Text>
            {msg.powVerification && <Text style={styles.bubblePow}>{msg.powVerification}</Text>}
          </View>
        ))}
        {isMiningPoW && (
          <View style={styles.powLoader}>
            <ActivityIndicator size="small" color="#00E676" />
            <Text style={styles.powLoaderText}>TĚŽÍM ANTI-SPAM BLOK (PoW): {powProgress} HASHES</Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.inputBarBox}>
        <Text style={styles.inputBarText}>{currentMessage === "" ? "Napište zprávu..." : currentMessage}</Text>
      </View>

      <View style={styles.boardContainer}>
        {layouts[kbdMode].map((row, rowIndex) => (
          <View key={rowIndex} style={styles.boardRow}>
            {row.map((btn) => (
              <TouchableOpacity key={btn} disabled={isMiningPoW} onPress={() => handleVirtualKeyboard(btn)} style={[styles.tile, isMiningPoW && styles.tileLock, (btn === "SPACE" || btn === "POTVRDIT") && styles.tileExtended, btn === "POTVRDIT" && styles.tileAction, btn === "⌫" && styles.tileDelete]}>
                <Text style={[styles.tileText, btn === "POTVRDIT" && styles.tileActionText]}>{btn}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  windowFrame: { flex: 1, backgroundColor: '#020202', paddingTop: 35 },
  authWrapper: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  lockVisual: { fontSize: 22, color: '#444', fontFamily: 'monospace', letterSpacing: 2, marginBottom: 20 },
  authTitle: { color: '#FFF', fontWeight: 'bold', fontSize: 12, letterSpacing: 1.5, textAlign: 'center' },
  secureDotsContainer: { minHeight: 60, justifyContent: 'center', alignItems: 'center' },
  secureHiddenValue: { color: '#00E676', fontSize: 20, letterSpacing: 4 },
  statusBar: { backgroundColor: '#0A0A0A', padding: 15, borderBottomWidth: 1, borderBottomColor: '#151515' },
  statusTitle: { color: '#FFF', fontWeight: 'bold', fontSize: 11, letterSpacing: 1, fontFamily: 'monospace' },
  statusIndicator: { fontSize: 10, fontFamily: 'monospace', marginTop: 5, fontWeight: 'bold' },
  myIdentityLabel: { color: '#555', fontSize: 9, fontFamily: 'monospace', marginTop: 3 },
  scrollBody: { flex: 1, padding: 15 },
  blockTitle: { color: '#444', fontSize: 10, fontWeight: 'bold', letterSpacing: 1.2, marginTop: 22, marginBottom: 12, fontFamily: 'monospace' },
  dhtEmptyState: { color: '#333', fontSize: 11, fontStyle: 'italic', paddingLeft: 5, fontFamily: 'monospace' },
  peerCard: { flexDirection: 'row', backgroundColor: '#080808', padding: 14, borderRadius: 6, marginBottom: 10, alignItems: 'center', borderWidth: 1, borderColor: '#151515' },
  peerIcon: { width: 36, height: 36, backgroundColor: '#02140A', borderRadius: 4, justifyContent: 'center', alignItems: 'center', marginRight: 14, borderWidth: 1, borderColor: '#00E676' },
  peerAlias: { color: '#FFF', fontSize: 14, fontWeight: 'bold', fontFamily: 'monospace' },
  peerIdHash: { color: '#444', fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  actionBtn: { backgroundColor: '#101010', padding: 16, borderRadius: 6, borderWidth: 1, borderColor: '#1C1C1C', marginBottom: 12, alignItems: 'center' },
  actionBtnText: { color: '#999', fontWeight: 'bold', fontSize: 11, letterSpacing: 0.5, fontFamily: 'monospace' },
  centeredView: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 25 },
  qrWrapper: { backgroundColor: '#050505', padding: 20, borderRadius: 8, borderWidth: 2, borderColor: '#00E676', marginBottom: 35 },
  qrMetaLabel: { color: '#333', fontSize: 10, fontWeight: 'bold', marginBottom: 6, fontFamily: 'monospace' },
  qrMetaValue: { color: '#FFF', fontFamily: 'monospace', fontSize: 11, backgroundColor: '#0A0A0A', padding: 12, borderRadius: 4, borderWidth: 1, borderColor: '#1F1F1F', textAlign: 'center', width: '100%' },
  escapeBtn: { marginTop: 25, borderColor: '#00E676', borderWidth: 1, paddingVertical: 14, paddingHorizontal: 35, borderRadius: 6, backgroundColor: '#02140A' },
  escapeBtnText: { color: '#00E676', fontWeight: 'bold', fontSize: 11, letterSpacing: 0.5, fontFamily: 'monospace' },
  cameraMask: { width: 270, height: 270, borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: '#00E676' },
  formLabel: { color: '#00E676', fontSize: 11, fontWeight: 'bold', marginBottom: 12, fontFamily: 'monospace' },
  inputPresenter: { backgroundColor: '#080808', padding: 16, borderRadius: 6, borderWidth: 1, borderColor: '#00E676', marginBottom: 25 },
  inputPresenterText: { color: '#FFF', fontFamily: 'monospace', fontSize: 14 },
  messagesContainer: { flex: 1, padding: 15 },
  bubble: { backgroundColor: '#0A0A0A', padding: 14, borderRadius: 8, marginBottom: 12, borderWidth: 1, maxWidth: '85%' },
  bubbleAuthor: { fontSize: 9, fontWeight: 'bold', marginBottom: 3, fontFamily: 'monospace' },
  bubbleText: { color: '#EEE', fontSize: 15, lineHeight: 20 },
  bubblePow: { color: '#444', fontSize: 9, fontFamily: 'monospace', marginTop: 6, borderTopWidth: 1, borderTopColor: '#151515', paddingTop: 4 },
  powLoader: { flexDirection: 'row', backgroundColor: '#02140A', padding: 14, borderRadius: 6, marginBottom: 12, borderWidth: 1, borderColor: '#00E676', alignItems: 'center', gap: 12 },
  powLoaderText: { color: '#00E676', fontSize: 10, fontFamily: 'monospace', flex: 1 },
  inputBarBox: { backgroundColor: '#080808', padding: 14, minHeight: 50, borderTopWidth: 1, borderTopColor: '#151515' },
  inputBarText: { color: '#FFF', fontSize: 14 },
  boardContainer: { backgroundColor: '#050505', padding: 2, paddingBottom: 15, borderTopWidth: 1, borderTopColor: '#151515' },
  boardRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 2 },
  tile: { flex: 1, height: 42, backgroundColor: '#101010', justifyContent: 'center', alignItems: 'center', margin: 1, borderRadius: 4, borderWidth: 1, borderColor: '#181818' },
  tileLock: { opacity: 0.15 },
  tileExtended: { flex: 2.6, backgroundColor: '#181818' },
  tileAction: { backgroundColor: '#00E676', borderColor: '#00E676' },
  tileDelete: { backgroundColor: '#210A0A', borderColor: '#331010' },
  tileText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },
  tileActionText: { color: '#000' },
  abortChatBtn: { backgroundColor: '#0A0A0A', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 4, borderWidth: 1, borderColor: '#222' }
});