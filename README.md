# gig-tracker
Looks for new gigs announced in my local area

Deploy command:

gcloud functions deploy checkGigs \
  --runtime nodejs22 \
  --trigger-http \
  --allow-unauthenticated \
  --region us-west1 \
  --set-env-vars SONGKICK_API_KEY=<SONGKICK_API_KEY> \
  --timeout=300s

In index.html replace CLOUD_FUNCTION_URL with the URL of the gcloud deployment