# Introduction

Hello and welcome to the Wayflyer take home assignment! We very much appreciate you taking the time to complete it and 
hope you enjoy yourself!

The assignment is to write a lightweight billing system to charge our customers daily. In the next stage of the interview 
process, you'll collaborate with an engineer on our team to discuss and extend your solution. 

To keep this exercise fair for all future candidates, *please keep your solution private*.

# The Exercise
Our core financial product is the Merchant Cash Advance (MCA), which is a form of revenue based financing. Our customers 
will sell us their future sales in return for cash now. We'll transfer them the cash directly to their bank account, then 
commence billing the next day. Every day we'll charge them a pre-agreed percentage of their previous days sales until 
they've paid us back the amount, plus a small fee we charge for the service.

Write a program that interacts with the API described below that correctly bills all our advances over the simulated 
period.

## Guidelines
Please write your solution in either Python or JavaScript/TypeScript.

Focus on the actual solution and meeting the specification first. Polish if you have the time. Good solutions can be implemented in under 3 hours.

To constrain the exercise, don't worry about data persistence or having a productionised system. State may be held in memory and the solution can be invoked by the command line. You may also assume that the
execution environment is 100% reliable.

A good solution should meet the specification, but ideally also be idiomatic, maintainable, and have appropriate test coverage. If you do run out of time, please annotate your code with TODOs highlighting areas that you would have wanted to improve or extend.

We support the use of coding agents during this exercise.
But, you're accountable for the architecture and the quality of the solution, and will need to explain it and develop it further in later interviews.

You are welcome to structure the code as you like. The example below uses Python-style pseudocode, but JavaScript/TypeScript is equally acceptable:
```python
def run_billing(today: date):
    ...

def simulate():
    for today in date_range(START_DATE, END_DATE):
        # pass `today` in your API request headers
        run_billing(today)
```

You can test the API from the command line:

```
curl -H "Today: 2022-01-02" https://billing.eng-test.wayflyer.com/v2/advances
curl -H "Today: 2022-01-02" https://billing.eng-test.wayflyer.com/v2/mandates/1/charge -X POST -H "Content-Type: application/json" -d '{"amount": "1.00"}'
```

Please let us know as soon as possible if there is a problem with the API.

## Submitting your results
Send us an archive containing your project, including any documentation required to set up and run your solution.

## Evaluation
When evaluating your work, we ask the following questions:
1. How do you follow and implement a set of requirements?
1. How do you make it easy for us to understand and run your solution?
1. How do you ensure your code is robust and working as expected?
1. Is the code you produce well written, easy to follow and maintainable?

If you have any questions please don't hesitate to reach out to us!

# API Reference

Your billing implementation should interact with this simple Restful API we've created for this exercise. The API
returns JSON-encoded responses, and uses standard HTTP verbs and response codes. No authentication is required.

You should simulate the passage of time by including an HTTP header `Today: {date}` with each request. The API will return
data as though the request was made on that day. The simulated period starts `2022-01-01` and ends on `2022-02-01`.

All dates are encoded as `{yyyy}-{mm}-{dd}`, i.e. `2022-03-21`.

HTTP POST request headers should include `Content-Type: application/json`.

For this exercise you should assume there is only one global currency. All monetary amounts are encoded as strings with two
decimal places encoding the lowest denomination (i.e. "12345.67").

The base URL for all requests is: `https://billing.eng-test.wayflyer.com/v2`. This is a live server with sample data you should use to develop your code.


## Advances
Fetch all advances issued to customers. 
<table>
<tr>
<td>

```
GET /advances

Response:
{"advances": [
  {
    "id": 1001,
    "customer_id": 1,
    "created": "2022-01-02",
    "total_advanced": "60000.00",
    "fee": "2000.00",
    "mandate_id": 102,
    "repayment_start_date": "2022-01-07",
    "repayment_percentage": 11
  },
  ...
  ]
}
```

</td>
<td>

| Field | Description |
|-------|-------------|
| id    | The unique identifier for each advance. |
| customer_id | The unique identifier for the customer this advance is for. |
| created | The date the advance was agreed. This may be before repayment starts. |
| total_advanced | The monetary amount advanced to the customer. |
| fee | The fee for this advance, to be paid back in addition to `total_advanced`. |
| mandate_id | The unique identifier of the direct debit mandate to charge this advance with. |
| repayment_start_date | Repayments should start on this date, and continue every day until the advance and fee have been repaid. |
| repayment_percentage | The percentage of daily revenue that should be repaid. |

</td>
</tr>
</table>

> Important: New advances are created regularly as we sign up new customers and give additional advances to existing customers.

## Revenues
Retrieve the revenue for a given customer for a given date.
<table>
<tr>
<td>

```
GET /customers/:id/revenues/:for_date
        
Response:        
{"amount": "1234.56"}
        
Errors:
530 Revenue not yet available
```

</td>
<td>

| Field | Description |
|-------|-------------|
| id | The unique identifier for the customer. |
| for_date | The date the revenue was received by the customer. |
| amount | The amount of revenue received. |

</td>
</tr>
</table>
 
> Important: Due to problems with third-party systems, a customer's revenue for a given day may not be available until
> a later day. In this case, we should bill the customer as soon as the revenue becomes available, unless the advance has
> otherwise been fully repaid.

## Charges
Issue repayment charges against a given mandate 
<table>
<tr>
<td>

```
POST /mandates/:id/charge
BODY {"amount": "1234.56"}

Errors:
530 Charging not possible at this time
```

</td>
<td>

| Field | Description |
|-------|-------------|
| id | The unique identifier for the mandate. |
| amount | The amount to charge against the given advance. |

</td>
</tr>
</table>

> Important: The total charges made against any advance should not exceed `10000.00` on any given day. Charges greater
> than this should be split over multiple days.

> Important: Due to problems with the direct debit mandate, charges on a given day may be rejected. In this case,
> charges should be issued on subsequent days.
 
## Billing Complete
Indicate that billing has been completed for a given advance. This should be called following successful final payment.
<table>
<tr>
<td>

```
POST /advances/:id/billing_complete
BODY {}
```

</td>
<td>

| Field | Description |
|-------|-------------|
| id | The unique identifier for the advance. |

</td>
</tr>
</table>
