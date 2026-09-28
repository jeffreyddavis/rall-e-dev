export const MAX_STOPS = 3;
export const EVENTS = [
  { id: 'rooftop', category: 'live shows', title: 'Golden hour, good company', short: 'Rooftop sounds', venue: 'The Juniper Rooftop', area: 'Hollywood', time: 'Saturday · 9:00 PM', doors: '8:30 PM', duration: '2 hours', price: 20, age: '21+', tag: 'A little music. A lot of atmosphere.', description: 'An open-air DJ set, warm city lights, and room to catch up between tracks. A Saturday that doesn’t need overthinking.', accessibility: 'Elevator access; some standing areas.', color: 'rooftop', source: 'Rall-e curated demo', fictional: true },
  { id: 'trail', category: 'nature', title: 'Take the scenic route', short: 'Sunset on the trail', venue: 'Fern Ridge Trail', area: 'Hollywood Hills', time: 'Saturday · 5:00 PM', doors: 'Meet at the trailhead at 5:00 PM', duration: '90 minutes', price: 0, age: 'All ages', tag: 'Less screen time. More skyline.', description: 'A gentle hillside walk with a golden-hour lookout. Bring water, comfortable shoes, and someone who appreciates a good view.', accessibility: 'Uneven dirt paths; not wheelchair accessible.', color: 'trail', source: 'Rall-e curated demo', fictional: true },
  { id: 'comedy', category: 'live shows', title: 'Your kind of laugh track', short: 'Small-room stand-up', venue: 'The Foundry', area: 'Hollywood', time: 'Saturday · 8:00 PM', doors: '7:30 PM', duration: '90 minutes', price: 25, age: '21+', tag: 'Big laughs. A small room.', description: 'An intimate stand-up showcase with a fresh lineup and a laid-back crowd. The kind of night you’ll still quote on Sunday.', accessibility: 'Step-free entrance; accessible seating on request.', color: 'comedy', source: 'Rall-e curated demo', fictional: true },
  { id: 'dinner', category: 'dinner', title: 'A table worth gathering around', short: 'Dinner at Casa Vera', venue: 'Casa Vera', area: 'Hollywood', time: 'Saturday · 6:00 PM', doors: 'Opens at 5:00 PM', duration: '90 minutes', price: 35, age: 'All ages', tag: 'Pass the plates. Stay a little longer.', description: 'Seasonal small plates, a leafy courtyard, and an unhurried evening with your favorite people. $35 is a sample per-person estimate.', accessibility: 'Step-free courtyard access.', color: 'dinner', source: 'Rall-e curated demo', fictional: true },
  { id: 'museum', category: 'museums', title: 'A fresh way to see the city', short: 'After-hours art', venue: 'The Westlight Gallery', area: 'Hollywood', time: 'Saturday · 4:00 PM', doors: '3:30 PM', duration: '90 minutes', price: 12, age: 'All ages', tag: 'A little curiosity goes a long way.', description: 'An easy afternoon of photography and contemporary art, with plenty to talk about after. No art-history degree required.', accessibility: 'Step-free entry and accessible restrooms.', color: 'museum', source: 'Rall-e curated demo', fictional: true }
];
export const eventById = id => EVENTS.find(e => e.id === id);
export const categoryFrom = text => {
  if (/hik|outdoor|nature|walk|trail|sunset/i.test(text)) return 'nature';
  if (/comed|laugh|stand.?up/i.test(text)) return 'comedy';
  if (/dinner|food|eat|restaurant/i.test(text)) return 'dinner';
  if (/museum|gallery|\bart\b/i.test(text)) return 'museums';
  if (/music|dj|live|rooftop|dance|show/i.test(text)) return 'live shows';
  return null;
};
