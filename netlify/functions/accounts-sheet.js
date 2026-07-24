exports.handler = async (event) => {
  console.log("METHOD:", event.httpMethod);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      worked: true,
      method: event.httpMethod,
      time: Date.now()
    })
  };
};
