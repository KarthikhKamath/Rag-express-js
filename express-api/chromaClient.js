const axios = require("axios");

async function query(query, topK = 5) {
    const response = await axios.post("http://localhost:5000/query", {
      query,
      n_results: topK
    });
    return response.data;
  }
  

module.exports = { query };
