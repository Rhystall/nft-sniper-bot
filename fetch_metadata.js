const { Alchemy, Network } = require("alchemy-sdk");
const fs = require("fs");
require("dotenv").config();

// Konfigurasi Alchemy
const config = {
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.ETH_MAINNET, // death and taxes ada di Ethereum
};

if (!config.apiKey) {
    throw new Error("ALCHEMY_API_KEY belum di-set di file .env");
}

const alchemy = new Alchemy(config);

// Address Smart Contract "death and taxes"
// (Cara carinya: Buka salah satu NFT-nya di OpenSea, scroll ke 'Details', klik 'Contract Address')
const contractAddress = "MASUKIN_ADDRESS_CONTRACT_DI_SINI";

async function fetchAllMetadata() {
    console.log("🚀 Gas narik data metadata...");
    let allNFTs = [];
    let pageKey = undefined;
    let hasNextPage = true;

    try {
        while (hasNextPage) {
            // Panggil API Alchemy buat narik NFT di contract ini
            const response = await alchemy.nft.getNftsForContract(contractAddress, {
                pageKey: pageKey,
                withMetadata: true, // Wajib true biar trait/tipe-nya kebaca
            });

            // Format ulang datanya biar JSON-nya rapi
            const nfts = response.nfts.map((nft) => {
                const traits = {};

                // Looping untuk nyimpen trait (kayak type: teddy, pepe, dll)
                if (nft.raw.metadata && nft.raw.metadata.attributes) {
                    nft.raw.metadata.attributes.forEach(attr => {
                        // Ubah jadi lowercase biar gampang dicari bot nanti
                        traits[attr.trait_type.toLowerCase()] = attr.value.toLowerCase();
                    });
                }

                return {
                    tokenId: nft.tokenId,
                    name: nft.name || `Citizen #${nft.tokenId}`,
                    traits: traits
                };
            });

            allNFTs.push(...nfts);
            console.log(`✅ Berhasil nge-cache ${allNFTs.length} NFT...`);

            // Cek apakah masih ada halaman selanjutnya (Pagination)
            pageKey = response.pageKey;
            if (!pageKey) {
                hasNextPage = false;
            }
        }

        // Simpan ke file local JSON
        fs.writeFileSync("data_citizen.json", JSON.stringify(allNFTs, null, 2));
        console.log(`🎉 Mantap cuy! Total ${allNFTs.length} metadata NFT berhasil diamankan ke data_citizen.json`);

    } catch (error) {
        console.error("❌ Waduh, ada error nih:", error);
    }
}

// Eksekusi fungsinya
fetchAllMetadata();
