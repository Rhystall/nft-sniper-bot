const { Alchemy, Network } = require("alchemy-sdk");
const fs = require("fs");
require("dotenv").config();

// Alchemy configuration
const config = {
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.ETH_MAINNET, // death and taxes is on Ethereum
};

if (!config.apiKey) {
    throw new Error("ALCHEMY_API_KEY belum di-set di file .env");
}

const alchemy = new Alchemy(config);

// "death and taxes" smart contract address
// (How to find it: open one NFT on OpenSea, scroll to "Details", click "Contract Address")
const DEFAULT_CONTRACT_ADDRESS = "0x4f249b2dc6cecbd549a0c354bbfc4919e8c5d3ae";
const OUTPUT_FILE = "data_nft.json";

const cliContract = process.argv[2];
const contractAddress = cliContract || DEFAULT_CONTRACT_ADDRESS;

function assertValidContractAddress(address) {
    const isValid = /^0x[a-fA-F0-9]{40}$/.test(address);
    if (!isValid) {
        throw new Error(
            `Contract address tidak valid: ${address}. Format yang benar: 0x + 40 hex.`,
        );
    }
}

async function resolveCollectionSlug(targetContractAddress) {
    try {
        const contractMetadata = await alchemy.nft.getContractMetadata(targetContractAddress);
        const slugFromContract = contractMetadata?.openSeaMetadata?.collectionSlug;
        if (slugFromContract) {
            return slugFromContract;
        }
    } catch (error) {
        console.warn(`⚠️ Gagal baca contract metadata untuk slug: ${error.message}`);
    }

    try {
        const nftSample = await alchemy.nft.getNftsForContract(targetContractAddress, {
            pageSize: 1,
            withMetadata: false,
        });
        const slugFromNftSample = nftSample?.nfts?.[0]?.collection?.slug;
        if (slugFromNftSample) {
            return slugFromNftSample;
        }
    } catch (error) {
        console.warn(`⚠️ Gagal fallback slug via sample NFT: ${error.message}`);
    }

    return null;
}

async function fetchAllMetadata() {
    assertValidContractAddress(contractAddress);
    console.log(`📦 Contract: ${contractAddress}`);

    const collectionSlug = await resolveCollectionSlug(contractAddress);
    if (collectionSlug) {
        console.log(`🔎 COLLECTION_SLUG=${collectionSlug}`);
    } else {
        console.warn(
            "⚠️ COLLECTION_SLUG tidak ditemukan otomatis. Lanjut fetch metadata seperti biasa.",
        );
    }

    console.log("🚀 Gas narik data metadata...");
    let allNFTs = [];
    let pageKey = undefined;
    let hasNextPage = true;

    try {
        while (hasNextPage) {
            // Call the Alchemy API to fetch NFTs for this contract
            const response = await alchemy.nft.getNftsForContract(contractAddress, {
                pageKey: pageKey,
                withMetadata: true, // Must be true so traits/types are readable
            });

            // Reformat data so the JSON output is clean
            const nfts = response.nfts.map((nft) => {
                const traits = {};

                // Loop through traits to store them (e.g., type: teddy, pepe, etc.)
                if (nft.raw.metadata && nft.raw.metadata.attributes) {
                    nft.raw.metadata.attributes.forEach(attr => {
                        // Convert to lowercase so the bot can search easily later
                        traits[attr.trait_type.toLowerCase()] = attr.value.toLowerCase();
                    });
                }

                return {
                    tokenId: nft.tokenId,
                    name: nft.name || `NFT #${nft.tokenId}`,
                    traits: traits
                };
            });

            allNFTs.push(...nfts);
            console.log(`✅ Berhasil nge-cache ${allNFTs.length} NFT...`);

            // Check whether there is a next page (pagination)
            pageKey = response.pageKey;
            if (!pageKey) {
                hasNextPage = false;
            }
        }

        // Save to a local JSON file
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allNFTs, null, 2));
        console.log(`🎉 Mantap cuy! Total ${allNFTs.length} metadata NFT berhasil diamankan ke ${OUTPUT_FILE}`);

    } catch (error) {
        console.error("❌ Waduh, ada error nih:", error);
    }
}

// Execute the function
fetchAllMetadata();
