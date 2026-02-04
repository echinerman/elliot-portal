// config.js
// Shared configuration for Client and Admin portals

export const CONFIG = {
    // Firebase Project Config
    FIREBASE: {
        apiKey: "AIzaSyAH5CRCJoktmY6baXshDnOVgylHldcPa3E",
        authDomain: "elliotvip.firebaseapp.com",
        projectId: "elliotvip",
        storageBucket: "elliotvip.firebasestorage.app",
        messagingSenderId: "223494244969",
        appId: "1:223494244969:web:edcf227f756ac76ba170f8"
    },
    
    // Business Logic
    ADMIN_EMAIL: "e.chinerman@gmail.com", // Matches firestore.rules
    INVITE_CODE: "FAMILY8K",            // Client-side gatekeeping
    CONTACT_LINK: "mailto:whaleshark809@flounderfantasy.com",
    
    // UI Constants
    CURRENCY_SYMBOL: "$",
    CRYPTO_SYMBOL: "₿"
};
