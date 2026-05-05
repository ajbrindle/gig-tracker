const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore();
const collectionName = 'gigs';

const SONGKICK_API_KEY = process.env.SONGKICK_API_KEY;
const METRO_AREA_ID = '24475'; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

exports.checkGigs = async (req, res) => {
    // CORS Headers
    res.set('Access-Control-Allow-Origin', '*'); 
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.status(204).send('');
        return;
    }

    try {
        const action = req.query.action;

        if (action === 'sync') {
            /* =========================================
               MODE 1: THE NIGHTLY SCRAPE 
               ========================================= */
            console.log("Starting Nightly Sync...");
            
            // Set min_date to 14 days from today
            const minDate = new Date();
            minDate.setDate(minDate.getDate() + 14);
            const minDateStr = minDate.toISOString().split('T')[0];

            // Set max_date to 2 years from today
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
                            isNew: !isSeedMode
                        });
                    }
                }
                page++;
                await sleep(3000); // Polite delay
            }

            res.status(200).send("Sync complete.");

        } else if (action === 'markSeen') {
            /* =========================================
               MODE 2: MARK ALL AS SEEN
               ========================================= */
            console.log("Clearing 'isNew' flags...");
            
            const snapshot = await firestore.collection(collectionName).where('isNew', '==', true).get();
            
            if (snapshot.empty) {
                return res.status(200).send("Nothing to clear.");
            }

            const batch = firestore.batch();
            snapshot.docs.forEach(doc => {
                batch.update(doc.ref, { isNew: false });
            });

            await batch.commit();
            res.status(200).send(`Cleared ${snapshot.size} gigs.`);

        } else {
            /* =========================================
               MODE 3: READ ONLY (Instantly returns to UI)
               ========================================= */
            console.log("Fetching new gigs for UI...");
            
            const snapshot = await firestore.collection(collectionName)
                                            .where('isNew', '==', true)
                                            .get();
            
            let newGigsList = [];
            snapshot.forEach(doc => {
                newGigsList.push(doc.data());
            });

            // THIS is the part that was missing! We group the data before sending it.
            const groupedGigs = newGigsList.reduce((acc, gig) => {
                if (!acc[gig.venue]) acc[gig.venue] = [];
                acc[gig.venue].push(gig);
                return acc;
            }, {});

            res.status(200).json({
                newGigs: groupedGigs
            });
        }

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};