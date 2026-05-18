const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore();
const collectionName = 'gigs';

const SONGKICK_API_KEY = process.env.SONGKICK_API_KEY;
const METRO_AREA_ID = '24475'; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

exports.checkGigs = async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*'); 
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.status(204).send('');
        return;
    }

    try {
        const action = req.query.action;
        const todayStr = new Date().toISOString().split('T')[0];

        if (action === 'sync') {
            /* === MODE 1: NIGHTLY SCRAPE & CLEANUP === */
            console.log("Sweeping for past gigs...");
            const pastGigsSnapshot = await firestore.collection(collectionName).where('date', '<', todayStr).get();
            let deletedCount = 0;
            if (!pastGigsSnapshot.empty) {
                for (const doc of pastGigsSnapshot.docs) {
                    await doc.ref.delete();
                    deletedCount++;
                }
            }
            
            const minDate = new Date();
            minDate.setDate(minDate.getDate() + 14);
            const minDateStr = minDate.toISOString().split('T')[0];

            const maxDate = new Date();
            maxDate.setFullYear(maxDate.getFullYear() + 2);
            const maxDateStr = maxDate.toISOString().split('T')[0];

            let page = 1;
            let totalEntries = 1; 
            const snapshot = await firestore.collection(collectionName).limit(10).get();
            const isSeedMode = snapshot.size < 10;

            while ((page - 1) * 50 < totalEntries) {
                const url = `https://api.songkick.com/api/3.0/metro_areas/${METRO_AREA_ID}/calendar.json?apikey=${SONGKICK_API_KEY}&min_date=${minDateStr}&max_date=${maxDateStr}&page=${page}&per_page=50`;
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Songkick API Error: ${response.status}`);
                
                const data = await response.json();
                const events = data.resultsPage.results.event || [];
                if (page === 1) totalEntries = data.resultsPage.totalEntries;

                for (const gig of events) {
                    const gigId = gig.id.toString();
                    const docRef = firestore.collection(collectionName).doc(gigId);
                    const doc = await docRef.get();

                    if (!doc.exists) {
                        await docRef.set({
                            id: gigId,
                            artist: gig.performance[0]?.displayName || 'Unknown',
                            venue: gig.venue.displayName,
                            date: gig.start.date,
                            ticketUrl: gig.uri,
                            discoveredAt: new Date().toISOString(),
                            isNew: !isSeedMode,
                            interested: false 
                        });
                    }
                }
                page++;
                await sleep(3000); 
            }
            res.status(200).send(`Sync complete. Cleaned up ${deletedCount} old gigs.`);

        } else if (action === 'toggleInterested') {
            /* === MODE 2: TOGGLE INTEREST FLAG === */
            const gigId = req.query.gigId;
            const isInterested = req.query.interested === 'true'; 
            if (!gigId) return res.status(400).send("Missing gigId");
            await firestore.collection(collectionName).doc(gigId).update({ interested: isInterested });
            res.status(200).send("Updated interest status.");

        } else if (action === 'markSeen') {
            /* === MODE 3: MARK AS SEEN === */
            const snapshot = await firestore.collection(collectionName).where('isNew', '==', true).get();
            if (snapshot.empty) return res.status(200).send("Nothing to clear.");

            const batch = firestore.batch();
            let clearedCount = 0;
            snapshot.docs.forEach(doc => {
                if (doc.data().interested !== true) {
                    batch.update(doc.ref, { isNew: false });
                    clearedCount++;
                }
            });
            if (clearedCount > 0) await batch.commit();
            res.status(200).send(`Cleared ${clearedCount} gigs.`);

        } else if (action === 'venue') {
            /* === MODE 4: GET ALL GIGS FOR A SPECIFIC VENUE === */
            const venueName = req.query.venue;
            if (!venueName) return res.status(400).send("Missing venue name");

            // Fetch all gigs matching this venue regardless of isNew status
            const snapshot = await firestore.collection(collectionName).where('venue', '==', venueName).get();
            
            let venueGigs = [];
            snapshot.forEach(doc => {
                const gigData = doc.data();
                // Ensure id is set (use document ID as fallback for backwards compatibility)
                if (!gigData.id) {
                    gigData.id = doc.id;
                }
                venueGigs.push(gigData);
            });

            // Sort them chronologically by date
            venueGigs.sort((a, b) => new Date(a.date) - new Date(b.date));

            res.status(200).json({ gigs: venueGigs });

        } else {
            /* === MODE 5: READ ONLY (NEW GIGS + SAVED GIGS) === */
            const newGigsSnapshot = await firestore.collection(collectionName).where('isNew', '==', true).get();
            const savedGigsSnapshot = await firestore.collection(collectionName).where('interested', '==', true).get();

            const gigsById = new Map();
            const addGig = (doc) => {
                const gigData = doc.data();
                if (!gigData.id) {
                    gigData.id = doc.id;
                }
                gigsById.set(gigData.id, gigData);
            };

            newGigsSnapshot.forEach(addGig);
            savedGigsSnapshot.forEach(addGig);

            const combinedGigs = Array.from(gigsById.values());
            const groupedGigs = combinedGigs.reduce((acc, gig) => {
                if (!acc[gig.venue]) acc[gig.venue] = [];
                acc[gig.venue].push(gig);
                return acc;
            }, {});
            res.status(200).json({ newGigs: groupedGigs });
        }

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};